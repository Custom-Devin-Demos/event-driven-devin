const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Retail finance accounts available in Account Manager.
 */
const ACCOUNTS = [
  {
    id: 'RAC-4471920',
    productType: 'retail_installment',
    vehicle: { year: 2024, model: 'F-150 Lightning', vin: '1FT6W1EV2PWG07842' },
    principal: 58420.00,
    apr: 0.0599,
    termMonths: 72,
  },
  {
    id: 'LSE-2208314',
    productType: 'red_carpet_lease',
    vehicle: { year: 2025, model: 'Mustang Mach-E', vin: '3FMTK1RM5PMA51133' },
    principal: 44310.00,
    apr: 0.0429,
    termMonths: 36,
  },
];

/**
 * Finance product configuration — drives escrow handling, grace periods,
 * and which add-on programs are eligible.
 */
const FINANCE_PRODUCTS = {
  retail_installment: { gracePeriodDays: 10, escrowManaged: true, lateFee: 28 },
  red_carpet_lease: { gracePeriodDays: 7, escrowManaged: false, lateFee: 35, mileageCap: 10500 },
};

/**
 * Account protection / add-on programs offered to eligible accounts.
 */
const PROTECTION_PROGRAMS = [
  { id: 'gap', label: 'GAP Coverage', monthly: 12.50, minTermMonths: 48 },
  { id: 'esp', label: 'Extended Service Plan', monthly: 39.00, minTermMonths: 36 },
  { id: 'tire', label: 'Tire & Wheel Protection', monthly: 9.75, minTermMonths: 24 },
];

function resolveAccount(accountId) {
  return ACCOUNTS.find((a) => a.id === accountId) || ACCOUNTS[0];
}

/**
 * Standard amortization for a fixed-rate installment balance.
 */
function computeAmortization(principal, apr, termMonths) {
  const monthlyRate = apr / 12;
  const factor = (monthlyRate * Math.pow(1 + monthlyRate, termMonths))
    / (Math.pow(1 + monthlyRate, termMonths) - 1);
  const monthlyPrincipalInterest = principal * factor;
  const totalOfPayments = monthlyPrincipalInterest * termMonths;
  return {
    monthlyPrincipalInterest: Math.round(monthlyPrincipalInterest * 100) / 100,
    totalOfPayments: Math.round(totalOfPayments * 100) / 100,
    totalInterest: Math.round((totalOfPayments - principal) * 100) / 100,
  };
}

/**
 * Resolve the protection programs an account currently qualifies for.
 */
function getEligiblePrograms(account) {
  return PROTECTION_PROGRAMS
    .filter((p) => account.termMonths >= p.minTermMonths)
    .map((p) => ({ id: p.id, label: p.label, monthly: p.monthly }));
}

/**
 * Build the payment plan for an account: the monthly breakdown, autopay
 * defaults, and any escrow held for tax/insurance on managed products.
 */
function buildPaymentPlan(account, amort, programs) {
  const product = FINANCE_PRODUCTS[account.productType];
  const programsMonthly = programs.reduce((sum, p) => sum + p.monthly, 0);

  const plan = {
    accountId: account.id,
    monthlyPrincipalInterest: amort.monthlyPrincipalInterest,
    programsMonthly: Math.round(programsMonthly * 100) / 100,
    gracePeriodDays: product.gracePeriodDays,
    autopay: {
      enrolled: true,
      dayOfMonth: 15,
      method: 'checking',
    },
  };

  if (product.escrowManaged) {
    const taxPortion = account.principal * 0.0008;
    const insurancePortion = account.principal * 0.0011;
    plan.escrow = {
      taxPortion: Math.round(taxPortion * 100) / 100,
      insurancePortion: Math.round(insurancePortion * 100) / 100,
      monthlyEscrow: Math.round((taxPortion + insurancePortion) * 100) / 100,
    };
  }

  return plan;
}

/**
 * Assemble the customer-facing account summary shown on the dashboard.
 */
function summarizeAccount(plan, account, amort) {
  const monthlyTotal = plan.monthlyPrincipalInterest
    + plan.programsMonthly
    + plan.escrow.monthlyEscrow;

  return {
    accountId: account.id,
    vehicle: `${account.vehicle.year} Ford ${account.vehicle.model}`,
    vin: account.vehicle.vin,
    apr: account.apr,
    termMonths: account.termMonths,
    monthlyPrincipalInterest: plan.monthlyPrincipalInterest,
    monthlyEscrow: plan.escrow.monthlyEscrow,
    programsMonthly: plan.programsMonthly,
    monthlyTotal: Math.round(monthlyTotal * 100) / 100,
    totalInterest: amort.totalInterest,
    autopayDay: plan.autopay.dayOfMonth,
    gracePeriodDays: plan.gracePeriodDays,
  };
}

/**
 * Processes an Account Manager dashboard summary request.
 */
async function processAccountSummary(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Building Account Manager summary', {
    requestId,
    accountId: data.accountId,
    service: 'customer-841afdc1-credit',
    route: '/api/841afdc1/account-summary',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 110));

    const account = resolveAccount(data.accountId);
    const amort = computeAmortization(account.principal, account.apr, account.termMonths);
    const programs = getEligiblePrograms(account);
    const plan = buildPaymentPlan(account, amort, programs);
    const summary = summarizeAccount(plan, account, amort);

    summary.requestId = requestId;
    summary.generatedAt = new Date().toISOString();

    const duration = Date.now() - startTime;

    incrementMetric('account_summary.success', {
      route: '/api/841afdc1/account-summary',
      productType: account.productType,
    });
    recordTiming('account_summary.latency', duration, {
      route: '/api/841afdc1/account-summary',
    });

    return summary;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('account_summary.failure', {
      route: '/api/841afdc1/account-summary',
      errorClass: error.name,
    });
    recordTiming('account_summary.latency', duration, {
      route: '/api/841afdc1/account-summary',
      error: 'true',
    });

    logger.error('Account Manager summary failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      accountId: data.accountId,
      service: 'customer-841afdc1-credit',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/841afdc1/account-summary',
        service: 'customer-841afdc1-credit',
        productType: data.productType,
      },
      extra: { requestId, accountId: data.accountId },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/841afdc1.js \u2014 summarizeAccount',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-841afdc1-credit',
      verticalLabel: 'Account Manager Summary',
      customer: '841afdc1',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/841afdc1/account-summary' },
        { key: 'service', value: 'customer-841afdc1-credit' },
        { key: 'productType', value: data.productType },
      ],
      extra: { requestId, accountId: data.accountId },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-841afdc1-credit@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for account summary error', {
        error: err.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = { processAccountSummary, ACCOUNTS, FINANCE_PRODUCTS, PROTECTION_PROGRAMS };
