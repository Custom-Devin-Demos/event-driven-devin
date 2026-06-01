const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Account types offered by the bank
 */
const ACCOUNT_TYPES = {
  'cuenta-online': { monthlyFee: 0, minIncome: 0, interestRate: 0.0 },
  'cuenta-nomina': { monthlyFee: 0, minIncome: 12000, interestRate: 0.25 },
  'cuenta-joven': { monthlyFee: 0, minIncome: 0, interestRate: 0.1 },
  'cuenta-business': { monthlyFee: 9.90, minIncome: 24000, interestRate: 0.5 },
};

/**
 * Regions with their risk multipliers
 */
const REGION_FACTORS = {
  madrid: { multiplier: 1.0, tags: ['urban', 'high-density', 'central'] },
  barcelona: { multiplier: 1.0, tags: ['urban', 'high-density', 'coastal'] },
  valencia: { multiplier: 0.95, tags: ['urban', 'coastal', 'growing'] },
  sevilla: { multiplier: 0.9, tags: ['urban', 'southern', 'historic'] },
  bilbao: { multiplier: 1.05, tags: ['urban', 'industrial', 'northern'] },
};

/**
 * Validate applicant eligibility and produce a risk assessment.
 */
function validateApplicant(data) {
  const accountSpec = ACCOUNT_TYPES[data.accountType];
  if (!accountSpec) {
    throw Object.assign(new Error(`Unknown account type: ${data.accountType}`), { code: 'INVALID_ACCOUNT_TYPE' });
  }

  const incomeCheck = data.income >= accountSpec.minIncome;
  const employmentCheck = data.employmentYears >= 1;
  const score = Math.min(100, Math.round(
    (data.income / 1000) * 1.2 + data.employmentYears * 5
  ));

  return { scores: [score, incomeCheck ? 10 : -20, employmentCheck ? 10 : -30] };
}

/**
 * Compute the interest rate offer based on the validation assessment.
 */
function computeInterestRate(assessment, accountType) {
  const baseRate = ACCOUNT_TYPES[accountType].interestRate;
  const riskScore = assessment.criteria.primary;
  const bonusRate = riskScore > 70 ? 0.15 : 0;
  return { offered: baseRate + bonusRate, riskScore };
}

/**
 * Build the final application result with region-adjusted terms.
 */
function buildApplication(applicationId, data, rateOffer) {
  const region = REGION_FACTORS[data.region] || REGION_FACTORS.madrid;
  const adjustedRate = rateOffer.offered * region.multiplier;

  return {
    applicationId,
    accountType: data.accountType,
    applicantType: data.applicantType,
    offeredRate: adjustedRate.toFixed(2) + '%',
    riskScore: rateOffer.riskScore,
    region: data.region,
    status: 'approved',
    processedAt: new Date().toISOString(),
  };
}

/**
 * Process a new account application.
 */
async function processApplication(data) {
  const startTime = Date.now();
  const applicationId = uuidv4();

  logger.info('Processing account application', {
    applicationId,
    accountType: data.accountType,
    region: data.region,
    service: 'customer-32850e60-api',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 100));

    const assessment = validateApplicant(data);
    const rateOffer = computeInterestRate(assessment, data.accountType);
    const application = buildApplication(applicationId, data, rateOffer);

    const duration = Date.now() - startTime;

    incrementMetric('application.success', {
      route: '/api/32850e60/apply',
      accountType: data.accountType,
    });
    recordTiming('application.latency', duration, {
      route: '/api/32850e60/apply',
    });

    return {
      success: true,
      ...application,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('application.failure', {
      route: '/api/32850e60/apply',
      errorClass: error.name,
      accountType: data.accountType,
    });
    recordTiming('application.latency', duration, {
      route: '/api/32850e60/apply',
      error: 'true',
    });

    logger.error('Application processing failed', {
      applicationId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      accountType: data.accountType,
      region: data.region,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/32850e60/apply',
        service: 'customer-32850e60-api',
        accountType: data.accountType,
      },
      extra: {
        applicationId,
        accountType: data.accountType,
        region: data.region,
        income: data.income,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/32850e60.js — processApplication',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-32850e60-api',
      verticalLabel: 'Account Application',
      customer: '32850e60',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/32850e60/apply' },
        { key: 'service', value: 'customer-32850e60-api' },
        { key: 'accountType', value: data.accountType },
      ],
      extra: { applicationId, accountType: data.accountType, region: data.region, income: data.income },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-32850e60@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from application error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processApplication, ACCOUNT_TYPES, REGION_FACTORS };
