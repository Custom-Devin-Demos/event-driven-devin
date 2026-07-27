const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Consumer credit profiles keyed by score model.
 */
const CREDIT_PROFILES = {
  'fico-8': {
    label: 'FICO\u00ae Score 8',
    range: { min: 300, max: 850 },
    tradelines: [
      { type: 'revolving', balance: 1840, limit: 10000, ageMonths: 62 },
      { type: 'revolving', balance: 420, limit: 5000, ageMonths: 38 },
      { type: 'installment', balance: 12600, original: 22000, ageMonths: 29 },
    ],
    inquiries: 1,
    derogatoryMarks: 0,
  },
  'vantage-4': {
    label: 'VantageScore 4.0',
    range: { min: 300, max: 850 },
    tradelines: [
      { type: 'revolving', balance: 2210, limit: 8000, ageMonths: 51 },
      { type: 'installment', balance: 9400, original: 15000, ageMonths: 44 },
    ],
    inquiries: 2,
    derogatoryMarks: 0,
  },
};

const SCORE_BANDS = [
  { floor: 800, band: 'Exceptional' },
  { floor: 740, band: 'Very Good' },
  { floor: 670, band: 'Good' },
  { floor: 580, band: 'Fair' },
  { floor: 300, band: 'Poor' },
];

/**
 * Collect weighted scoring factors from the consumer profile.
 */
function collectScoreFactors(profile) {
  const revolving = profile.tradelines.filter((t) => t.type === 'revolving');
  const totalBalance = revolving.reduce((sum, t) => sum + t.balance, 0);
  const totalLimit = revolving.reduce((sum, t) => sum + t.limit, 0);
  const avgAge = profile.tradelines.reduce((sum, t) => sum + t.ageMonths, 0)
    / profile.tradelines.length;

  return {
    utilization: { ratio: totalLimit ? totalBalance / totalLimit : 0, weight: 0.3 },
    paymentHistory: { ratio: profile.derogatoryMarks ? 0.6 : 1, weight: 0.35 },
    creditAge: { ratio: Math.min(avgAge / 120, 1), weight: 0.15 },
    inquiries: { ratio: Math.max(1 - profile.inquiries * 0.1, 0), weight: 0.1 },
    creditMix: { ratio: profile.tradelines.length > 2 ? 1 : 0.7, weight: 0.1 },
  };
}

/**
 * Summarize scoring factors into headline metrics for the report.
 */
function summarizeFactors(factors) {
  return {
    utilizationPct: factors.utilization.ratio * 100,
    weightedScore: Object.values(factors)
      .reduce((sum, f) => sum + f.ratio * f.weight, 0),
  };
}

/**
 * Map the weighted composite onto the score range and band.
 */
function calculateScore(summary, profile) {
  const { min, max } = profile.range;
  const score = Math.round(min + summary.weightedScore * (max - min));
  const band = SCORE_BANDS.find((b) => score >= b.floor);

  return {
    score,
    band: band ? band.band : 'Unrated',
    utilization: `${summary.utilizationPct.toFixed(1)}%`,
  };
}

/**
 * Processes a free credit report request.
 */
async function processCreditReportRequest(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Processing credit report request', {
    requestId,
    bureau: data.bureau,
    scoreModel: data.scoreModel,
    service: 'customer-f26260e1-demo',
    route: '/api/f26260e1/credit-report',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const profile = CREDIT_PROFILES[data.scoreModel] || CREDIT_PROFILES['fico-8'];
    const factors = collectScoreFactors(profile);
    const summary = summarizeFactors(factors);
    const result = calculateScore(summary, profile);

    const report = {
      requestId,
      model: profile.label,
      score: result.score,
      band: result.band,
      utilization: result.utilization,
      generatedAt: new Date().toISOString(),
    };

    const duration = Date.now() - startTime;

    incrementMetric('credit_report.success', {
      route: '/api/f26260e1/credit-report',
      scoreModel: data.scoreModel,
    });
    recordTiming('credit_report.latency', duration, {
      route: '/api/f26260e1/credit-report',
    });

    return report;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('credit_report.failure', {
      route: '/api/f26260e1/credit-report',
      errorClass: error.name,
    });
    recordTiming('credit_report.latency', duration, {
      route: '/api/f26260e1/credit-report',
      error: 'true',
    });

    logger.error('Credit report request failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      bureau: data.bureau,
      scoreModel: data.scoreModel,
      service: 'customer-f26260e1-demo',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/f26260e1/credit-report',
        service: 'customer-f26260e1-demo',
        scoreModel: data.scoreModel,
      },
      extra: { requestId, bureau: data.bureau, scoreModel: data.scoreModel },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/f26260e1.js \u2014 summarizeFactors',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-f26260e1-demo',
      verticalLabel: 'Credit Report Request',
      customer: 'f26260e1',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/f26260e1/credit-report' },
        { key: 'service', value: 'customer-f26260e1-demo' },
        { key: 'scoreModel', value: data.scoreModel },
      ],
      extra: { requestId, bureau: data.bureau, scoreModel: data.scoreModel },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-f26260e1-demo@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for credit report error', {
        error: err.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = {
  processCreditReportRequest,
  collectScoreFactors,
  summarizeFactors,
  CREDIT_PROFILES,
  SCORE_BANDS,
};
