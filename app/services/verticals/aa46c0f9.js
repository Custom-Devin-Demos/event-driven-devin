const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Travelers personal auto coverage packages. `annualBase` is the base annual
 * premium before state factors, vehicle count, and driver adjustments.
 */
const COVERAGE_PACKAGES = {
  basic: {
    label: 'Basic',
    liability: '25/50/25',
    collisionDeductible: 1000,
    annualBase: 1180,
    features: [],
  },
  standard: {
    label: 'Standard',
    liability: '100/300/100',
    collisionDeductible: 500,
    annualBase: 1540,
    features: [],
  },
  premier: {
    label: 'Premier',
    liability: '250/500/250',
    collisionDeductible: 250,
    annualBase: 1920,
    features: ['Premier New Car Replacement', 'Accident Forgiveness'],
  },
};

/**
 * State rating factors. `factor` scales the base auto premium and
 * `premiumTaxRate` is the state premium tax applied to the rated premium.
 */
const STATE_FACTORS = {
  CT: { factor: 1.08, premiumTaxRate: 0.02 },
  NY: { factor: 1.22, premiumTaxRate: 0.03 },
  MA: { factor: 1.05, premiumTaxRate: 0.025 },
  NJ: { factor: 1.18, premiumTaxRate: 0.02 },
  TX: { factor: 1.11, premiumTaxRate: 0.02 },
  CA: { factor: 1.15, premiumTaxRate: 0.025 },
  MN: { factor: 0.96, premiumTaxRate: 0.02 },
};

/**
 * Policy lines the rating engine can price, keyed by line code.
 */
const POLICY_LINES = {
  auto: { label: 'Personal Auto', minimumPremium: 600, policyFee: 25 },
  home: { label: 'Homeowners', minimumPremium: 450, policyFee: 0 },
  renters: { label: 'Renters', minimumPremium: 120, policyFee: 0 },
};

/**
 * Bundle offers keyed by the bundled product. Each carries a discount applied
 * to the bundled policy's annual premium, plus an optional complimentary
 * endorsement attached to the quote.
 */
const BUNDLE_OFFERS = {
  home: {
    label: 'Bundle Home + Auto — save up to 13%',
    discountRate: 0.13,
    annualPremium: 1385,
    endorsement: {
      code: 'IDFX',
      name: 'Identity Fraud Expense Coverage (included with bundle)',
      premium: 0,
      policyLine: 'identity-fraud',
    },
  },
  renters: {
    label: 'Bundle Renters + Auto — save up to 10%',
    discountRate: 0.10,
    annualPremium: 210,
    endorsement: null,
  },
};

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Travelers auto quote + purchase vertical:',
  '- Service: `app/services/verticals/aa46c0f9.js`',
  '- Route: `app/routes/verticals/aa46c0f9.js`',
  '- Page: `app/public/verticals/aa46c0f9.html` (served at `/travelers`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function validationError(message, code) {
  return Object.assign(new Error(message), {
    name: 'ValidationError',
    code,
    status: 400,
  });
}

function roundCents(amount) {
  return Math.round(amount * 100) / 100;
}

/**
 * Resolve the bundle attached to the quote. `null`, `'none'`, or a missing
 * value means auto-only; unknown bundle keys are rejected.
 */
function resolveBundle(bundle) {
  if (bundle === undefined || bundle === null || bundle === 'none') return null;
  const offer = Object.hasOwn(BUNDLE_OFFERS, bundle) ? BUNDLE_OFFERS[bundle] : null;
  if (!offer) {
    throw validationError(`Unknown bundle: ${bundle}`, 'INVALID_BUNDLE');
  }
  return offer;
}

/**
 * Attach the bundle's complimentary endorsement to the quote lines.
 */
function applyBundleEndorsements(lines, bundle) {
  if (!bundle || !bundle.endorsement) return lines;
  return [...lines, { ...bundle.endorsement }];
}

/**
 * Group quote lines into policies, one per policy line.
 */
function buildPolicies(lines) {
  const policies = new Map();

  for (const line of lines) {
    const policyLine = line.policyLine || 'auto';
    if (!policies.has(policyLine)) {
      policies.set(policyLine, { line: policyLine, items: [] });
    }
    policies.get(policyLine).items.push(line);
  }

  return [...policies.values()];
}

/**
 * Rate a single policy: floor at the line's minimum premium, add the policy
 * fee, then apply the state premium tax.
 */
function ratePolicy(policy) {
  const rules = POLICY_LINES[policy.line];
  const subtotal = policy.items.reduce((sum, item) => sum + item.premium, 0);
  const premium = Math.max(subtotal, rules.minimumPremium) + rules.policyFee;
  const premiumTaxRate = policy.items[0] ? policy.items[0].premiumTaxRate || 0 : 0;

  return {
    line: policy.line,
    label: rules.label,
    subtotal: roundCents(subtotal),
    premium: roundCents(premium),
    premiumTax: roundCents(premium * premiumTaxRate),
    coverages: policy.items,
  };
}

/**
 * Quote and bind a Travelers auto policy (optionally bundled with home or
 * renters coverage).
 */
async function purchasePolicy(data) {
  if (!Object.hasOwn(STATE_FACTORS, data.state)) {
    throw validationError(`Unknown state: ${data.state}`, 'INVALID_STATE');
  }
  if (!/^\d{5}$/.test(String(data.zipCode || ''))) {
    throw validationError(`Invalid ZIP code: ${data.zipCode}`, 'INVALID_ZIP');
  }
  if (!Array.isArray(data.vehicles) || data.vehicles.length === 0) {
    throw validationError('At least one vehicle is required', 'NO_VEHICLES');
  }

  const packageKey = data.coveragePackage || 'standard';
  const coveragePackage = Object.hasOwn(COVERAGE_PACKAGES, packageKey)
    ? COVERAGE_PACKAGES[packageKey]
    : null;
  if (!coveragePackage) {
    throw validationError(
      `Unknown coverage package: ${data.coveragePackage}`,
      'INVALID_PACKAGE',
    );
  }
  const bundle = resolveBundle(data.bundle);

  const paymentPlan = data.paymentPlan || 'monthly';
  if (!['monthly', 'annual'].includes(paymentPlan)) {
    throw validationError(
      `Unknown payment plan: ${data.paymentPlan}`,
      'INVALID_PAYMENT_PLAN',
    );
  }
  if (data.effectiveDate && !/^\d{4}-\d{2}-\d{2}$/.test(data.effectiveDate)) {
    throw validationError(
      `Invalid effective date: ${data.effectiveDate}`,
      'INVALID_EFFECTIVE_DATE',
    );
  }

  const startTime = Date.now();
  const quoteId = uuidv4();
  const policyNumber = `TRV-${String(Math.floor(100000 + Math.random() * 900000))}`;

  logger.info('Processing Travelers auto quote purchase', {
    quoteId,
    package: data.coveragePackage,
    bundle: data.bundle,
    state: data.state,
    zipCode: data.zipCode,
    vehicles: data.vehicles.length,
    service: 'travelers-auto-quote',
    route: '/api/aa46c0f9/quote/purchase',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const stateFactor = STATE_FACTORS[data.state];
    const drivers = Array.isArray(data.drivers) && data.drivers.length > 0
      ? data.drivers
      : [{ name: 'Primary driver', age: 40 }];
    const youngDriverAdjustment = drivers.some((driver) => Number(driver.age) < 25)
      ? 1.35
      : 1;

    const autoPremium = coveragePackage.annualBase
      * stateFactor.factor
      * data.vehicles.length
      * youngDriverAdjustment;

    const lines = [
      {
        policyLine: 'auto',
        name: `${coveragePackage.label} Auto — liability ${coveragePackage.liability}`,
        premium: autoPremium,
        premiumTaxRate: stateFactor.premiumTaxRate,
      },
    ];

    let bundleSavings = 0;
    if (bundle) {
      const bundlePremium = bundle.annualPremium * (1 - bundle.discountRate);
      bundleSavings = bundle.annualPremium * bundle.discountRate;
      lines.push({
        policyLine: data.bundle,
        name: `${POLICY_LINES[data.bundle].label} — bundled`,
        premium: bundlePremium,
        premiumTaxRate: stateFactor.premiumTaxRate,
      });
    }

    const quoteLines = applyBundleEndorsements(lines, bundle);
    const policies = buildPolicies(quoteLines).map(ratePolicy);

    const annualPremium = policies.reduce(
      (sum, policy) => sum + policy.premium + policy.premiumTax,
      0,
    );
    const monthlyPremium = paymentPlan === 'monthly'
      ? annualPremium / 12 + 3
      : annualPremium / 12;

    const duration = Date.now() - startTime;

    incrementMetric('auto_quote_purchase.success', {
      route: '/api/aa46c0f9/quote/purchase',
      bundle: data.bundle || 'none',
    });
    recordTiming('auto_quote_purchase.latency', duration, {
      route: '/api/aa46c0f9/quote/purchase',
    });

    return {
      success: true,
      quoteId,
      policyNumber,
      status: 'bound',
      package: coveragePackage.label,
      bundleLabel: bundle ? bundle.label : 'None',
      policies,
      bundleSavings: roundCents(bundleSavings),
      annualPremium: roundCents(annualPremium),
      monthlyPremium: roundCents(monthlyPremium),
      paymentPlan,
      effectiveDate: data.effectiveDate
        || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      boundAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('auto_quote_purchase.failure', {
      route: '/api/aa46c0f9/quote/purchase',
      errorClass: error.name,
      bundle: data.bundle || 'none',
    });
    recordTiming('auto_quote_purchase.latency', duration, {
      route: '/api/aa46c0f9/quote/purchase',
      error: 'true',
    });

    logger.error('Travelers auto quote purchase failed', {
      quoteId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      package: data.coveragePackage,
      bundle: data.bundle,
      state: data.state,
      service: 'travelers-auto-quote',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/aa46c0f9/quote/purchase',
        service: 'travelers-auto-quote',
        alert_path: 'instant',
        bundle: data.bundle,
      },
      extra: {
        quoteId,
        state: data.state,
        zipCode: data.zipCode,
        vehicles: data.vehicles.length,
        bundle: data.bundle,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/aa46c0f9.js — ratePolicy',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      customer: 'aa46c0f9',
      service: 'travelers-auto-quote',
      verticalLabel: 'Travelers Auto Quote & Purchase',
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: [
        { key: 'route', value: '/api/aa46c0f9/quote/purchase' },
        { key: 'service', value: 'travelers-auto-quote' },
        { key: 'bundle', value: data.bundle },
      ],
      extra: {
        quoteId,
        state: data.state,
        zipCode: data.zipCode,
        bundle: data.bundle,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'travelers-auto-quote@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Travelers quote error', {
        error: err.message,
        quoteId,
      });
    });

    throw error;
  }
}

module.exports = {
  purchasePolicy,
  REMEDIATION_DIRECTIVE,
  COVERAGE_PACKAGES,
  POLICY_LINES,
  BUNDLE_OFFERS,
  STATE_FACTORS,
  buildPolicies,
  ratePolicy,
  applyBundleEndorsements,
  resolveBundle,
};
