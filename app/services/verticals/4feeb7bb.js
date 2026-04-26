const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const REGIONS = [
  { code: 'stockholm', name: 'Stockholm', customers: 128000, avgBalance: 2450000, currency: 'SEK' },
  { code: 'gothenburg', name: 'Göteborg', customers: 64000, avgBalance: 1980000, currency: 'SEK' },
  { code: 'malmo', name: 'Malmö', customers: 42000, avgBalance: 1750000, currency: 'SEK' },
  { code: 'uppsala', name: 'Uppsala', customers: 31000, avgBalance: 2100000, currency: 'SEK' },
  { code: 'linkoping', name: 'Linköping', customers: 18000, avgBalance: 1620000, currency: 'SEK' },
];

const LOAN_PRODUCTS = [
  { id: 'MORT-VAR-3M', type: 'mortgage', description: 'Rörlig 3 mån', baseRate: 3.94, fixedPeriod: 0, maxLTV: 85, minAmount: 500000, tier: 'standard' },
  { id: 'MORT-FIX-1Y', type: 'mortgage', description: 'Bunden 1 år', baseRate: 3.45, fixedPeriod: 12, maxLTV: 85, minAmount: 500000, tier: 'standard' },
  { id: 'MORT-FIX-3Y', type: 'mortgage', description: 'Bunden 3 år', baseRate: 3.12, fixedPeriod: 36, maxLTV: 85, minAmount: 500000, tier: 'premium' },
  { id: 'MORT-FIX-5Y', type: 'mortgage', description: 'Bunden 5 år', baseRate: 3.29, fixedPeriod: 60, maxLTV: 85, minAmount: 500000, tier: 'premium' },
  { id: 'PERS-UNSEC', type: 'personal', description: 'Privatlån', baseRate: 6.95, fixedPeriod: 0, maxLTV: 0, minAmount: 30000, tier: 'standard' },
  { id: 'GREEN-MORT', type: 'mortgage', description: 'Grönt bolån', baseRate: 3.05, fixedPeriod: 36, maxLTV: 85, minAmount: 500000, tier: 'green' },
];

const RATE_ADJUSTMENTS = {
  variable: { spreadFactor: 1.0, processingFee: 0 },
  fixed_short: { spreadFactor: 0.92, processingFee: 1500 },
  fixed_long: { spreadFactor: 0.85, processingFee: 2500 },
};

const REGIONAL_FACTORS = {
  stockholm: { demandIndex: 1.15, riskMultiplier: 0.92, approvalRate: 0.88 },
  gothenburg: { demandIndex: 1.05, riskMultiplier: 0.95, approvalRate: 0.91 },
  malmo: { demandIndex: 0.98, riskMultiplier: 1.02, approvalRate: 0.86 },
  uppsala: { demandIndex: 1.08, riskMultiplier: 0.90, approvalRate: 0.93 },
  linkoping: { demandIndex: 0.88, riskMultiplier: 0.96, approvalRate: 0.90 },
};

function normalizeProductQuery(productId) {
  if (!productId) return null;
  const cleaned = productId.trim().toUpperCase();
  const segments = cleaned.split('-');
  if (segments.length < 2) return null;
  return {
    category: segments[0],
    variant: segments.slice(1).join('-'),
  };
}

function resolveProducts(loanType, productId) {
  let products;
  if (productId) {
    const parsed = normalizeProductQuery(productId);
    if (parsed) {
      products = LOAN_PRODUCTS.filter((p) => p.id.toUpperCase().includes(parsed.variant));
    }
  }
  if (!products || products.length === 0) {
    products = LOAN_PRODUCTS.filter((p) => p.type === loanType);
  }
  return products;
}

function getRegionalRateData(regionCode) {
  const factors = REGIONAL_FACTORS[regionCode];
  const region = REGIONS.find((r) => r.code === regionCode);
  return {
    marketConditions: {
      adjustedDemand: region.customers * factors.demandIndex,
      riskPremium: factors.riskMultiplier,
    },
    approvalRate: factors.approvalRate,
  };
}

function computeLoanMetrics(products, regionCode) {
  const rateData = getRegionalRateData(regionCode);
  return products.map((product) => {
    const adjustedRate = product.baseRate * rateData.pricing.riskPremium;
    const isCompetitive = adjustedRate < 4.0;
    return {
      productId: product.id,
      description: product.description,
      baseRate: product.baseRate,
      adjustedRate: Math.round(adjustedRate * 100) / 100,
      isCompetitive,
      tier: product.tier,
      maxLTV: product.maxLTV,
    };
  });
}

function calculateRateOffering(loanMetrics, adjustmentConfig, regionCode) {
  const rateData = getRegionalRateData(regionCode);
  const results = loanMetrics.map((metric) => {
    const spreadRate = metric.adjustedRate * adjustmentConfig.spreadFactor;
    const effectiveRate = spreadRate * rateData.pricing.adjustedDemand;
    const totalFees = adjustmentConfig.processingFee;

    return {
      productId: metric.productId,
      product: metric.description,
      baseRate: metric.baseRate,
      effectiveRate: Math.round(spreadRate * 100) / 100,
      monthlyEstimate: Math.round(effectiveRate),
      fees: totalFees,
      competitiveness: metric.isCompetitive ? 'COMPETITIVE' : 'STANDARD',
      tier: metric.tier,
    };
  });

  return results;
}

function buildRateResponse(offerings, region, rateType) {
  const competitiveProducts = offerings.filter((o) => o.competitiveness === 'COMPETITIVE');
  const avgRate = offerings.reduce((sum, o) => sum + o.effectiveRate, 0) / offerings.length;
  const totalFees = offerings.reduce((sum, o) => sum + o.fees, 0);

  return {
    region: region.name,
    regionCode: region.code,
    currency: region.currency,
    currentRate: Math.round(avgRate * 100) / 100,
    competitiveProducts: competitiveProducts.length,
    totalFees,
    rateType,
    products: offerings.map((o) => ({
      productId: o.productId,
      product: o.product,
      rate: o.effectiveRate,
      monthly: o.monthlyEstimate,
      status: o.competitiveness,
    })),
    recommendations: [],
  };
}

async function runInquiry(data) {
  const startTime = Date.now();
  const inquiryId = uuidv4();

  logger.info('Processing mortgage rate inquiry', {
    inquiryId,
    region: data.region,
    loanType: data.loanType,
    rateType: data.rateType,
    service: 'customer-4feeb7bb-banking',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const region = REGIONS.find((r) => r.code === data.region);
    const products = resolveProducts(data.loanType, data.productId);
    const loanMetrics = computeLoanMetrics(products, data.region);
    const adjustmentConfig = RATE_ADJUSTMENTS[data.rateType];
    const offerings = calculateRateOffering(loanMetrics, adjustmentConfig, data.region);
    const response = buildRateResponse(offerings, region, data.rateType);

    response.inquiryId = inquiryId;
    response.completedAt = new Date().toISOString();

    if (response.competitiveProducts > 0) {
      response.recommendations.push('Grönt bolån erbjuder lägsta räntan för energieffektiva bostäder');
      response.recommendations.push('Byt till bunden ränta för att låsa in nuvarande låga räntor');
    }
    if (response.currentRate > 4.5) {
      response.recommendations.push('Överväg att amortera extra för att sänka din totala räntekostnad');
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
      extra: { inquiryId, region: data.region, loanType: data.loanType },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/4feeb7bb.js \u2014 runInquiry',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-4feeb7bb-banking',
      verticalLabel: 'Mortgage Rate Inquiry',
      customer: '4feeb7bb',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/4feeb7bb/inquiry' },
        { key: 'service', value: 'customer-4feeb7bb-banking' },
        { key: 'region', value: data.region },
      ],
      extra: { inquiryId, region: data.region, loanType: data.loanType },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-4feeb7bb-banking@4.2.1',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for rate inquiry error', {
        error: err.message,
        inquiryId,
      });
    });

    throw error;
  }
}

module.exports = { runInquiry, REGIONS, LOAN_PRODUCTS };
