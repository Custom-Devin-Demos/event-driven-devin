const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Regional branch offices for the mortgage inquiry demo.
 */
const BRANCHES = [
  { code: 'stockholm', name: 'Stockholm Branch', region: 'SE-AB', mortgageVolume: 4200, currency: 'SEK' },
  { code: 'oslo', name: 'Oslo Branch', region: 'NO-03', mortgageVolume: 3100, currency: 'NOK' },
  { code: 'copenhagen', name: 'Copenhagen Branch', region: 'DK-84', mortgageVolume: 2850, currency: 'DKK' },
  { code: 'helsinki', name: 'Helsinki Branch', region: 'FI-18', mortgageVolume: 1960, currency: 'EUR' },
  { code: 'reykjavik', name: 'Reykjavik Branch', region: 'IS-01', mortgageVolume: 620, currency: 'ISK' },
];

/**
 * Mortgage product catalog.
 */
const MORTGAGE_PRODUCTS = [
  { id: 'MG-FIXED-30', type: 'fixed', name: '30-Year Fixed', baseRate: 3.25, termYears: 30, minDown: 0.20, maxLTV: 0.80 },
  { id: 'MG-FIXED-15', type: 'fixed', name: '15-Year Fixed', baseRate: 2.75, termYears: 15, minDown: 0.20, maxLTV: 0.80 },
  { id: 'MG-ARM-5-1', type: 'adjustable', name: '5/1 ARM', baseRate: 2.50, termYears: 30, minDown: 0.10, maxLTV: 0.90 },
  { id: 'MG-ARM-7-1', type: 'adjustable', name: '7/1 ARM', baseRate: 2.85, termYears: 30, minDown: 0.10, maxLTV: 0.90 },
  { id: 'MG-JUMBO-30', type: 'jumbo', name: 'Jumbo 30-Year', baseRate: 3.60, termYears: 30, minDown: 0.25, maxLTV: 0.75 },
  { id: 'MG-GREEN', type: 'green', name: 'Green Mortgage', baseRate: 2.95, termYears: 25, minDown: 0.15, maxLTV: 0.85 },
];

/**
 * Regional rate adjustments. Each region has a pricing object with
 * risk premium, base spread, and regulatory cap.
 */
const REGIONAL_RATES = {
  stockholm: { pricing: { riskPremium: 0.85, baseSpread: 1.20, regulatoryCap: 6.5 }, marketIndex: 'STIBOR' },
  oslo:      { pricing: { riskPremium: 0.78, baseSpread: 1.15, regulatoryCap: 7.0 }, marketIndex: 'NIBOR' },
  copenhagen:{ pricing: { riskPremium: 0.92, baseSpread: 1.30, regulatoryCap: 6.0 }, marketIndex: 'CIBOR' },
  helsinki:  { pricing: { riskPremium: 0.80, baseSpread: 1.10, regulatoryCap: 6.5 }, marketIndex: 'EURIBOR' },
  reykjavik: { pricing: { riskPremium: 1.15, baseSpread: 1.50, regulatoryCap: 8.0 }, marketIndex: 'REIBOR' },
};

/**
 * Look up regional rate data by region code.
 */
function getRegionalRateData(regionCode) {
  return REGIONAL_RATES[regionCode];
}

/**
 * Filter mortgage products by loan type.
 */
function resolveMortgageProducts(loanType) {
  if (!loanType || loanType === 'all') {
    return MORTGAGE_PRODUCTS;
  }
  const filtered = MORTGAGE_PRODUCTS.filter((p) => p.type === loanType);
  return filtered.length > 0 ? filtered : MORTGAGE_PRODUCTS;
}

/**
 * Compute loan metrics for each product given a region's rate data.
 */
function computeLoanMetrics(products, regionCode) {
  const rateData = getRegionalRateData(regionCode);
  return products.map((product) => {
    const adjustedRate = product.baseRate * rateData.pricing.riskPremium;
    const isCompetitive = adjustedRate < 4.0;
    return {
      productId: product.id,
      productName: product.name,
      type: product.type,
      baseRate: product.baseRate,
      adjustedRate: Math.round(adjustedRate * 1000) / 1000,
      isCompetitive,
      termYears: product.termYears,
      maxLTV: product.maxLTV,
      marketIndex: rateData.marketIndex,
    };
  });
}

/**
 * Calculate the monthly payment estimate for a given principal, rate, and term.
 */
function calculateMonthlyPayment(principal, annualRate, termYears) {
  const monthlyRate = annualRate / 100 / 12;
  const numPayments = termYears * 12;
  if (monthlyRate === 0) return principal / numPayments;
  return (principal * monthlyRate * Math.pow(1 + monthlyRate, numPayments)) /
         (Math.pow(1 + monthlyRate, numPayments) - 1);
}

/**
 * Build the full inquiry response from loan metrics.
 */
function buildInquiryResponse(loanMetrics, branch, loanType, principal) {
  const bestRate = Math.min(...loanMetrics.map((m) => m.adjustedRate));
  const competitiveCount = loanMetrics.filter((m) => m.isCompetitive).length;

  return {
    branch: branch.name,
    branchCode: branch.code,
    region: branch.region,
    currency: branch.currency,
    loanType: loanType || 'all',
    requestedPrincipal: principal,
    bestAvailableRate: bestRate,
    competitiveProducts: competitiveCount,
    products: loanMetrics.map((m) => ({
      productId: m.productId,
      name: m.productName,
      type: m.type,
      adjustedRate: m.adjustedRate,
      isCompetitive: m.isCompetitive,
      termYears: m.termYears,
      estimatedMonthly: Math.round(calculateMonthlyPayment(principal, m.adjustedRate, m.termYears) * 100) / 100,
      marketIndex: m.marketIndex,
    })),
    recommendations: [],
  };
}

/**
 * Run a mortgage rate inquiry for a given region, loan type, and principal.
 */
async function runInquiry(data) {
  const startTime = Date.now();
  const inquiryId = uuidv4();

  logger.info('Processing mortgage rate inquiry', {
    inquiryId,
    region: data.region,
    loanType: data.loanType,
    principal: data.principal,
    service: 'customer-4feeb7bb-banking',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const branch = BRANCHES.find((b) => b.code === data.region);
    const products = resolveMortgageProducts(data.loanType);
    const loanMetrics = computeLoanMetrics(products, data.region);
    const response = buildInquiryResponse(loanMetrics, branch, data.loanType, data.principal);

    response.inquiryId = inquiryId;
    response.completedAt = new Date().toISOString();

    if (response.competitiveProducts === 0) {
      response.recommendations.push('Consider adjustable-rate products for lower initial payments');
    }
    if (response.bestAvailableRate > 4.0) {
      response.recommendations.push('Current market rates are elevated; consider rate-lock options');
    }

    const duration = Date.now() - startTime;

    incrementMetric('inquiry.success', {
      route: '/api/4feeb7bb/inquiry',
      region: data.region,
    });
    recordTiming('inquiry.latency', duration, {
      route: '/api/4feeb7bb/inquiry',
    });

    return response;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('inquiry.failure', {
      route: '/api/4feeb7bb/inquiry',
      errorClass: error.name,
    });
    recordTiming('inquiry.latency', duration, {
      route: '/api/4feeb7bb/inquiry',
      error: 'true',
    });

    logger.error('Mortgage rate inquiry failed', {
      inquiryId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      region: data.region,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/4feeb7bb/inquiry',
        service: 'customer-4feeb7bb-banking',
        region: data.region,
      },
      extra: { inquiryId, loanType: data.loanType, region: data.region },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/4feeb7bb.js — runInquiry',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-4feeb7bb-banking',
      verticalLabel: 'Mortgage Rate Inquiry',
      customer: '4feeb7bb',
      tags: [
        { key: 'route', value: '/api/4feeb7bb/inquiry' },
        { key: 'service', value: 'customer-4feeb7bb-banking' },
        { key: 'region', value: data.region },
      ],
      extra: { inquiryId, loanType: data.loanType, region: data.region },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'acme-checkout@1.0.2',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from inquiry error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { runInquiry, BRANCHES, MORTGAGE_PRODUCTS };
