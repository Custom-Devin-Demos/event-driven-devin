const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/096058b1/free-trial';
const SERVICE = 'customer-096058b1-free-trial';
const SLACK_MEMBER_ID_FALLBACK = process.env.DIRECTV_SLACK_MEMBER_ID || '';

const GENRE_PACKS = [
  {
    code: 'MYSPORTS',
    name: 'MySports',
    price: 64.99,
    channelCount: 20,
    promo: { trialDays: 5, introPrice: 49.99, introMonths: 1 },
  },
  {
    code: 'MYENTERTAINMENT',
    name: 'MyEntertainment',
    price: 89.99,
    channelCount: 90,
    promo: { trialDays: 5, introPrice: 59.99, introMonths: 1 },
  },
  {
    code: 'MYNEWS',
    name: 'MyNews',
    price: 34.99,
    channelCount: 40,
    promo: { trialDays: 5, introPrice: 29.99, introMonths: 1 },
  },
  {
    code: 'MYKIDS',
    name: 'MyKids',
    price: 29.99,
    channelCount: 30,
    promo: { trialDays: 5, introPrice: 24.99, introMonths: 1 },
  },
];

const ADD_ONS = [
  {
    code: 'MYSPORTSEXTRA',
    name: 'MySports Extra',
    description: 'NFL RedZone + 8 sports channels',
    price: 13.99,
    channelCount: 8,
    requires: 'MYSPORTS',
    offer: { freeDays: 5, thenPrice: 13.99, waivedMonths: 1 },
  },
  {
    code: 'SPORTSPACK',
    name: 'Sports Pack',
    description: 'Additional live sports channels',
    price: 10.99,
    channelCount: 14,
    offer: { freeDays: 5, thenPrice: 10.99, waivedMonths: 1 },
  },
  {
    code: 'MOVIESEXTRA',
    name: 'Movies Extra',
    description: 'More premium movies and entertainment',
    price: 12.99,
    channelCount: 10,
    offer: { freeDays: 5, thenPrice: 12.99, waivedMonths: 1 },
  },
];

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the DIRECTV free-trial offer schedule:',
  '- Service: `app/services/verticals/096058b1.js`',
  '- Route: `app/routes/verticals/096058b1.js`',
  '- Page: `app/public/verticals/096058b1.html` (served at `/096058b1`)',
  '',
  'Preserve the current offer catalog and the successful MySports-only trial.',
  'Run `npm run lint` and the focused free-trial tests.',
  'Open a pull request against `main` with the fix.',
].join('\n');

function listOffers() {
  return GENRE_PACKS.concat(ADD_ONS).map((item) => ({
    code: item.code,
    name: item.name,
    description: item.description || '',
    price: item.price,
    channelCount: item.channelCount,
    requires: item.requires || null,
  }));
}

function resolveOfferItems(preConfigItems) {
  const codes = String(preConfigItems || '')
    .split(',')
    .map((code) => code.trim().toUpperCase())
    .filter(Boolean);

  if (codes.length === 0) {
    const error = new Error('Choose at least one offer to start a trial.');
    error.name = 'ValidationError';
    error.code = 'OFFER_REQUIRED';
    error.statusCode = 400;
    throw error;
  }

  const selected = codes.map((code) => {
    const pack = GENRE_PACKS.find((entry) => entry.code === code);
    const addOn = ADD_ONS.find((entry) => entry.code === code);
    const item = pack || addOn;
    if (!item) {
      const error = new Error(`The offer code "${code}" is not available.`);
      error.name = 'ValidationError';
      error.code = 'OFFER_NOT_FOUND';
      error.statusCode = 400;
      throw error;
    }
    return item;
  });

  const selectedCodes = new Set(selected.map((item) => item.code));
  selected.forEach((item) => {
    if (item.requires && !selectedCodes.has(item.requires)) {
      const error = new Error(`${item.name} requires ${item.requires}.`);
      error.name = 'ValidationError';
      error.code = 'REQUIRED_PACK_MISSING';
      error.statusCode = 400;
      throw error;
    }
  });

  return selected;
}

function buildTrialSchedule(items, trialDays) {
  const startedAt = new Date();
  return items.map((item) => {
    const duration = Math.min(Number(trialDays || item.promo.trialDays), item.promo.trialDays);
    const trialEndsAt = new Date(startedAt.getTime() + duration * 24 * 60 * 60 * 1000);
    const firstBillAt = new Date(trialEndsAt);
    firstBillAt.setUTCMonth(firstBillAt.getUTCMonth() + item.promo.introMonths);
    return { item, promo: item.promo, trialEndsAt, firstBillAt };
  });
}

function summarizeFirstBill(schedule) {
  return schedule.reduce((summary, entry) => {
    summary.introPrice += entry.promo.introPrice;
    summary.introMonths = Math.max(summary.introMonths, entry.promo.introMonths);
    return summary;
  }, { introPrice: 0, introMonths: 0 });
}

async function startFreeTrial(data) {
  const requestData = data || {};
  const startTime = Date.now();
  const requestId = `DTV-${uuidv4().slice(0, 8).toUpperCase()}`;

  logger.info('Starting DIRECTV free trial', {
    requestId,
    preConfigItems: requestData.preConfigItems,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    const items = resolveOfferItems(requestData.preConfigItems);
    const schedule = buildTrialSchedule(items, requestData.trialDays);
    const firstBill = summarizeFirstBill(schedule);
    const duration = Date.now() - startTime;
    const trialEndsAt = schedule[0].trialEndsAt.toISOString();

    incrementMetric('free_trial.start_success', { route: ROUTE });
    recordTiming('free_trial.start_latency', duration, { route: ROUTE });

    return {
      success: true,
      requestId,
      trialEndsAt,
      firstBill: {
        ...firstBill,
        dueAt: schedule[0].firstBillAt.toISOString(),
      },
      items: items.map((item) => ({
        code: item.code,
        name: item.name,
        price: item.price,
        channelCount: item.channelCount,
      })),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    error.requestId = requestId;

    if (error.name === 'ValidationError') {
      incrementMetric('free_trial.start_rejected', {
        route: ROUTE,
        code: error.code,
      });
      throw error;
    }

    incrementMetric('free_trial.start_failure', {
      route: ROUTE,
      errorClass: error.name,
    });
    recordTiming('free_trial.start_latency', duration, { route: ROUTE, error: 'true' });

    logger.error('DIRECTV free trial failed to start', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      preConfigItems: requestData.preConfigItems,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        alert_path: 'instant',
      },
      extra: {
        requestId,
        preConfigItems: requestData.preConfigItems,
        intent: requestData.intent,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/096058b1.js — buildTrialSchedule',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: requestData.devinUserId,
      devinEmail: requestData.devinEmail,
      devinOrgId: requestData.devinOrgId,
      service: SERVICE,
      verticalLabel: 'DIRECTV MySports free trial',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '096058b1',
      slackMemberIdFallback: SLACK_MEMBER_ID_FALLBACK,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'intent', value: requestData.intent || 'genre' },
      ],
      extra: {
        requestId,
        preConfigItems: requestData.preConfigItems,
        intent: requestData.intent,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@1.0.0`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for free-trial error', {
        error: alertError.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = {
  listOffers,
  startFreeTrial,
  resolveOfferItems,
  buildTrialSchedule,
  summarizeFirstBill,
};
