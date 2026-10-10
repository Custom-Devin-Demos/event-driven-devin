const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const JURISDICTIONS = {
  PA: {
    name: 'Pennsylvania — Philadelphia',
    country: 'US',
    currency: 'USD',
    taxType: 'Sales & Use',
    authorities: [
      { authority: 'Pennsylvania', rate: 0.06 },
      { authority: 'Philadelphia County', rate: 0.02 },
    ],
  },
  NY: {
    name: 'New York — New York City',
    country: 'US',
    currency: 'USD',
    taxType: 'Sales & Use',
    authorities: [
      { authority: 'NY State', rate: 0.04 },
      { authority: 'NYC', rate: 0.045 },
      { authority: 'MCTD', rate: 0.00375 },
    ],
  },
  TX: {
    name: 'Texas — Austin',
    country: 'US',
    currency: 'USD',
    taxType: 'Sales & Use',
    authorities: [
      { authority: 'Texas', rate: 0.0625 },
      { authority: 'City of Austin', rate: 0.01 },
      { authority: 'Austin MTA', rate: 0.01 },
    ],
  },
  CA: {
    name: 'California — San Francisco',
    country: 'US',
    currency: 'USD',
    taxType: 'Sales & Use',
    authorities: [
      { authority: 'California', rate: 0.0725 },
      { authority: 'San Francisco County', rate: 0.01375 },
    ],
  },
  WA: {
    name: 'Washington — Seattle',
    country: 'US',
    currency: 'USD',
    taxType: 'Sales & Use',
    authorities: [
      { authority: 'Washington', rate: 0.065 },
      { authority: 'Seattle RTA/City', rate: 0.0385 },
    ],
  },
  DE: {
    name: 'Germany',
    country: 'DE',
    currency: 'EUR',
    taxType: 'VAT',
    authorities: [
      { authority: 'Germany (Bundeszentralamt)', rate: 0.19 },
    ],
  },
  GB: {
    name: 'United Kingdom',
    country: 'GB',
    currency: 'GBP',
    taxType: 'VAT',
    authorities: [
      { authority: 'HMRC', rate: 0.20 },
    ],
  },
  'CA-ON': {
    name: 'Canada — Ontario',
    country: 'CA',
    currency: 'CAD',
    taxType: 'HST',
    authorities: [
      { authority: 'HST (Ontario)', rate: 0.13 },
    ],
  },
  'CA-NS': {
    name: 'Canada — Nova Scotia',
    country: 'CA',
    currency: 'CAD',
    taxType: 'HST',
    authorities: [
      { authority: 'HST (Nova Scotia)', rate: 0.15 },
    ],
  },
  'CA-BC': {
    name: 'Canada — British Columbia',
    country: 'CA',
    currency: 'CAD',
    taxType: 'GST/PST',
    authorities: [
      { authority: 'GST (CRA)', rate: 0.05 },
      { authority: 'PST (British Columbia)', rate: 0.07 },
    ],
  },
  'CA-QC': {
    name: 'Canada — Quebec',
    country: 'CA',
    currency: 'CAD',
    taxType: 'GST/QST',
    authorities: [
      { authority: 'GST (CRA)', rate: 0.05 },
      { authority: 'QST (Revenu Québec)', rate: 0.09975 },
    ],
  },
  'CA-AB': {
    name: 'Canada — Alberta',
    country: 'CA',
    currency: 'CAD',
    taxType: 'GST',
    authorities: [
      { authority: 'GST (CRA)', rate: 0.05 },
    ],
  },
};

const PRODUCT_CLASSES = [
  {
    code: 'SAAS',
    name: 'Cloud Software (SaaS) Subscription',
    taxabilityCategory: 'Digital — Remotely Accessed Software',
  },
  {
    code: 'TPP',
    name: 'Tangible Personal Property',
    taxabilityCategory: 'General Merchandise',
  },
  {
    code: 'SW_MAINT',
    name: 'Software Maintenance & Support',
    taxabilityCategory: 'Software Maintenance',
  },
  {
    code: 'PROF_SVC',
    name: 'Professional Services',
    taxabilityCategory: 'Professional Services',
  },
];

const MAX_LINE_AMOUNT = 1e9;
const MAX_QUANTITY = 1e6;

const TAXABILITY_MATRIX = {
  // Content release 2024.Q3 taxability drivers
  ELECTRONIC_SOFTWARE: { taxable: true, exemptIn: ['CA'] },
  TPP: { taxable: true, exemptIn: [] },
  SW_MAINT: { taxable: true, exemptIn: ['CA'] },
  PROF_SVC: { taxable: true, exemptIn: ['PA', 'CA', 'WA'] },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Vertex Cloud tax determination vertical:',
  '- Service: `app/services/verticals/513ad458.js`',
  '- Route: `app/routes/verticals/513ad458.js`',
  '- Page: `app/public/verticals/513ad458.html` (served at `/vertex`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function resolveTaxability(productClass, jurisdictionCode) {
  const rule = TAXABILITY_MATRIX[productClass];
  const taxable = rule.taxable && !rule.exemptIn.includes(jurisdictionCode);
  return {
    taxable,
    reason: taxable ? 'Taxable in jurisdiction' : 'Exempt in jurisdiction',
  };
}

function roundMoney(amount) {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

function computeJurisdictionTax(basis, jurisdiction, taxable) {
  const lineItems = jurisdiction.authorities.map(({ authority, rate }) => ({
    authority,
    rate,
    tax: roundMoney(taxable ? basis * rate : 0),
  }));
  const taxAmount = roundMoney(lineItems.reduce((total, item) => total + item.tax, 0));
  const taxRate = jurisdiction.authorities.reduce((total, item) => total + item.rate, 0);

  return { lineItems, taxRate, taxAmount };
}

function validateInput(data) {
  if (!Object.prototype.hasOwnProperty.call(JURISDICTIONS, data.jurisdiction)) {
    throw Object.assign(new Error(`Unknown jurisdiction: ${data.jurisdiction}`), {
      name: 'ValidationError',
      code: 'INVALID_JURISDICTION',
      status: 400,
    });
  }

  if (!PRODUCT_CLASSES.some(({ code }) => code === data.productClass)) {
    throw Object.assign(new Error(`Unknown product class: ${data.productClass}`), {
      name: 'ValidationError',
      code: 'INVALID_PRODUCT_CLASS',
      status: 400,
    });
  }

  if (typeof data.amount !== 'number' || !Number.isFinite(data.amount) || data.amount <= 0
    || data.amount > MAX_LINE_AMOUNT) {
    throw Object.assign(new Error(`Amount must be greater than zero and at most ${MAX_LINE_AMOUNT}`), {
      name: 'ValidationError',
      code: 'INVALID_AMOUNT',
      status: 400,
    });
  }

  if (!Number.isInteger(data.quantity) || data.quantity < 1 || data.quantity > MAX_QUANTITY) {
    throw Object.assign(new Error(`Quantity must be an integer between 1 and ${MAX_QUANTITY}`), {
      name: 'ValidationError',
      code: 'INVALID_QUANTITY',
      status: 400,
    });
  }
}

async function calculateTax(data) {
  const input = data || {};
  validateInput(input);

  const startTime = Date.now();
  const transactionId = uuidv4();
  const route = '/api/513ad458/calculate';

  logger.info('Calculating Vertex Cloud tax', {
    transactionId,
    companyCode: input.companyCode,
    customerCode: input.customerCode,
    jurisdiction: input.jurisdiction,
    productClass: input.productClass,
    amount: input.amount,
    quantity: input.quantity,
    service: 'vertex-tax-engine',
    route,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const jurisdiction = JURISDICTIONS[input.jurisdiction];
    const productClass = PRODUCT_CLASSES.find(({ code }) => code === input.productClass);
    const taxability = resolveTaxability(input.productClass, input.jurisdiction);
    const taxableBasis = roundMoney(input.amount * input.quantity);
    const tax = computeJurisdictionTax(taxableBasis, jurisdiction, taxability.taxable);
    const calculatedAt = new Date().toISOString();
    const duration = Date.now() - startTime;

    incrementMetric('tax.calculation.success', {
      route,
      source: 'vertex-cloud-console',
    });
    recordTiming('tax.calculation.latency', duration, { route });

    return {
      success: true,
      transactionId,
      status: 'calculated',
      companyCode: input.companyCode,
      jurisdiction: {
        code: input.jurisdiction,
        name: jurisdiction.name,
        taxType: jurisdiction.taxType,
      },
      productClass: {
        code: productClass.code,
        name: productClass.name,
        taxabilityCategory: productClass.taxabilityCategory,
      },
      taxable: taxability.taxable,
      taxableBasis,
      lineItems: tax.lineItems,
      taxRate: tax.taxRate,
      taxAmount: tax.taxAmount,
      total: roundMoney(taxableBasis + tax.taxAmount),
      currency: jurisdiction.currency,
      rulesEvaluated: 1284 + tax.lineItems.length,
      calculatedAt,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('tax.calculation.failure', {
      route,
      errorClass: error.name,
      source: 'vertex-cloud-console',
    });
    recordTiming('tax.calculation.latency', duration, {
      route,
      error: 'true',
    });

    logger.error('Vertex Cloud tax calculation failed', {
      transactionId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      companyCode: input.companyCode,
      customerCode: input.customerCode,
      service: 'vertex-tax-engine',
    });

    Sentry.captureException(error, {
      tags: {
        route,
        service: 'vertex-tax-engine',
        source: 'vertex-cloud-console',
        alert_path: 'instant',
      },
      extra: {
        transactionId,
        companyCode: input.companyCode,
        customerCode: input.customerCode,
        jurisdiction: input.jurisdiction,
        productClass: input.productClass,
        amount: input.amount,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/513ad458.js — resolveTaxability',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: input.devinUserId,
      devinEmail: input.devinEmail,
      devinOrgId: input.devinOrgId,
      customer: '513ad458',
      service: 'vertex-tax-engine',
      verticalLabel: 'Vertex Cloud Tax Determination',
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: [
        { key: 'route', value: route },
        { key: 'service', value: 'vertex-tax-engine' },
      ],
      extra: {
        transactionId,
        companyCode: input.companyCode,
        customerCode: input.customerCode,
        jurisdiction: input.jurisdiction,
        productClass: input.productClass,
        amount: input.amount,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'vertex-tax-engine@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Vertex tax calculation error', {
        error: err.message,
        transactionId,
      });
    });

    throw error;
  }
}

module.exports = {
  calculateTax,
  resolveTaxability,
  computeJurisdictionTax,
  JURISDICTIONS,
  PRODUCT_CLASSES,
  TAXABILITY_MATRIX,
  REMEDIATION_DIRECTIVE,
};
