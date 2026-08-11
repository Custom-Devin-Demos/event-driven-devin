const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const REGION_PARTITIONS = {
  'us-east-1': { partition: 'aws', geo: 'NA', zone: 'IAD' },
  'us-west-2': { partition: 'aws', geo: 'NA', zone: 'PDX' },
  'eu-west-1': { partition: 'aws', geo: 'EU', zone: 'DUB' },
  'ap-southeast-1': { partition: 'aws', geo: 'APAC', zone: 'SIN' },
};

const CREDIT_SCHEDULES = {
  NA: [
    ['free', { baseCredits: 100, bonusCredits: 100, windowMonths: 6 }],
    ['starter', { baseCredits: 300, bonusCredits: 200, windowMonths: 12 }],
  ],
  EU: [
    ['free', { baseCredits: 100, bonusCredits: 80, windowMonths: 6 }],
    ['starter', { baseCredits: 280, bonusCredits: 180, windowMonths: 12 }],
  ],
  APAC: [
    ['free', { baseCredits: 100, bonusCredits: 90, windowMonths: 6 }],
    ['starter', { baseCredits: 260, bonusCredits: 160, windowMonths: 12 }],
  ],
};

function resolveRegion(region) {
  const meta = REGION_PARTITIONS[region] || REGION_PARTITIONS['us-east-1'];
  return { region, ...meta };
}

function loadCreditSchedule(geo) {
  const entries = CREDIT_SCHEDULES[geo] || CREDIT_SCHEDULES.NA;
  return entries.map(([tier, terms]) => ({ tier, terms }));
}

function selectTierTerms(schedule, planTier) {
  const { terms } = schedule.find((entry) => entry.tier === planTier) || {};
  return terms;
}

const DEFAULT_PLAN_TIER = 'free';

function buildActivationPackage(regionInfo, planTier) {
  const schedule = loadCreditSchedule(regionInfo.geo);
  const tierTerms = selectTierTerms(schedule, planTier)
    || selectTierTerms(schedule, DEFAULT_PLAN_TIER);

  if (!tierTerms) {
    const error = new Error(`No credit schedule terms available for plan tier "${planTier}"`);
    error.code = 'UNKNOWN_PLAN_TIER';
    throw error;
  }

  return {
    accountRegion: regionInfo.region,
    zone: regionInfo.zone,
    totalCredits: tierTerms.baseCredits + tierTerms.bonusCredits,
    expiresInMonths: tierTerms.windowMonths,
  };
}

async function processAccountActivation(data) {
  const requestId = uuidv4();
  const startTime = Date.now();

  logger.info('Account activation request received', {
    requestId,
    planTier: data.planTier,
    region: data.region,
  });

  incrementMetric('vertical_40cf3e09.activation.requested', 1, [
    `tier:${data.planTier}`,
  ]);

  try {
    const regionInfo = resolveRegion(data.region);
    const activation = buildActivationPackage(regionInfo, data.planTier);

    recordTiming('vertical_40cf3e09.activation.duration', Date.now() - startTime);
    incrementMetric('vertical_40cf3e09.activation.succeeded', 1);

    logger.info('Account activation completed', { requestId, zone: activation.zone });

    return { success: true, requestId, activation };
  } catch (error) {
    incrementMetric('vertical_40cf3e09.activation.failed', 1, [
      `error:${error.name}`,
    ]);

    logger.error('Account activation failed', {
      requestId,
      error: error.message,
      errorType: error.name,
      planTier: data.planTier,
      region: data.region,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/40cf3e09/activate',
        service: 'customer-40cf3e09-demo',
        planTier: data.planTier,
      },
      extra: { requestId, planTier: data.planTier, region: data.region },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/40cf3e09.js — buildActivationPackage',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-40cf3e09-demo',
      verticalLabel: 'Account Activation Request',
      customer: '40cf3e09',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/40cf3e09/activate' },
        { key: 'service', value: 'customer-40cf3e09-demo' },
        { key: 'planTier', value: data.planTier },
      ],
      extra: { requestId, planTier: data.planTier, region: data.region },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-40cf3e09-demo@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for activation error', {
        error: err.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = {
  processAccountActivation,
  buildActivationPackage,
  resolveRegion,
  loadCreditSchedule,
  REGION_PARTITIONS,
  CREDIT_SCHEDULES,
  selectTierTerms,
};
