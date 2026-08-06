const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const CORRIDORS = {
  'USD-BRL': { rate: 5.24, fee: 0.009, settlementHours: 24, label: 'Brazilian real' },
  'USD-EUR': { rate: 0.92, fee: 0.007, settlementHours: 24, label: 'Euro' },
  'USD-MXN': { rate: 18.36, fee: 0.008, settlementHours: 12, label: 'Mexican peso' },
};

function buildCorridorIndex(corridors) {
  return Object.entries(corridors).map(([pair, details]) => ({
    pair,
    rate: details.rate,
    fee: details.fee,
  }));
}

function resolveCorridor(index, pair) {
  return index[pair.toLowerCase()];
}

function computeFxQuote(corridor, amount) {
  const exchangeRate = corridor.rate;
  const feeAmount = amount * corridor.fee;
  return {
    amount,
    exchangeRate,
    feeAmount: Math.round(feeAmount * 100) / 100,
    payout: Math.round((amount * corridor.rate - feeAmount) * 100) / 100,
  };
}

function assembleQuote(corridor, quote, pair, requestId) {
  return {
    requestId,
    corridor: pair,
    label: corridor.label,
    settlementHours: corridor.settlementHours,
    ...quote,
    quotedAt: new Date().toISOString(),
  };
}

async function processGlobalAccountQuote(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Processing global account corridor quote', {
    requestId,
    corridor: data.corridor,
    amount: data.amount,
    service: 'customer-b98fcab6-global-account',
    route: '/api/b98fcab6/global-account',
  });

  try {
    const pair = String(data.corridor || 'usd-brl').toUpperCase();
    const amount = Number(data.amount || 2500);
    const index = buildCorridorIndex(CORRIDORS);
    const corridor = resolveCorridor(index, pair);
    const quote = computeFxQuote(corridor, amount);
    const result = assembleQuote(corridor, quote, pair, requestId);
    const duration = Date.now() - startTime;

    incrementMetric('global_account_quote.success', {
      route: '/api/b98fcab6/global-account',
      corridor: pair,
    });
    recordTiming('global_account_quote.latency', duration, {
      route: '/api/b98fcab6/global-account',
    });

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('global_account_quote.failure', {
      route: '/api/b98fcab6/global-account',
      errorClass: error.name,
    });
    recordTiming('global_account_quote.latency', duration, {
      route: '/api/b98fcab6/global-account',
      error: 'true',
    });

    logger.error('Global account quote failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      corridor: data.corridor,
      amount: data.amount,
      service: 'customer-b98fcab6-global-account',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/b98fcab6/global-account',
        service: 'customer-b98fcab6-global-account',
        corridor: data.corridor,
      },
      extra: { requestId, corridor: data.corridor, amount: data.amount },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/b98fcab6.js — computeFxQuote',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-b98fcab6-global-account',
      verticalLabel: 'Global Account FX Transfer',
      customer: 'b98fcab6',
      slackMemberId: 'U0BKWFUG3PU',
      tags: [
        { key: 'route', value: '/api/b98fcab6/global-account' },
        { key: 'service', value: 'customer-b98fcab6-global-account' },
        { key: 'corridor', value: data.corridor },
      ],
      extra: { requestId, corridor: data.corridor, amount: data.amount },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-b98fcab6-global-account@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for global account error', {
        error: alertError.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = {
  CORRIDORS,
  buildCorridorIndex,
  resolveCorridor,
  computeFxQuote,
  assembleQuote,
  processGlobalAccountQuote,
};
