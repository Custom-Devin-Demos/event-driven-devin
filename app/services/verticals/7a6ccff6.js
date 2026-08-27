const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const RIGHTS_TERMS = require('./features/7a6ccff6-rights-terms.json').rightsTerms;

const EARNINGS_SOURCES = [
  {
    code: 'streaming-masters',
    name: 'Streaming masters — DSP royalties',
    territory: 'Global digital services',
    grossEarningsUsd: 126840.75,
    streamsMillions: 18.4,
    rightsClass: 'master_recording',
  },
  {
    code: 'publishing-catalog',
    name: 'Publishing catalog — mechanical royalties',
    territory: 'United States and Canada',
    grossEarningsUsd: 78940.2,
    streamsMillions: 0,
    rightsClass: 'publishing_mechanical',
  },
  {
    code: 'sync-placement',
    name: 'Sync placement — television campaign',
    territory: 'North America',
    grossEarningsUsd: 51200,
    streamsMillions: 0.12,
    rightsClass: 'sync_licensing',
  },
  {
    code: 'neighbouring-rights',
    name: 'Neighbouring rights — broadcast & public performance',
    territory: 'EU / UK collecting societies',
    grossEarningsUsd: 184920.44,
    streamsMillions: 0,
    rightsClass: 'neighbouring_rights',
  },
];

const WITHHOLDING_SCHEDULE = {
  master_recording: {
    label: 'Master recording royalties',
    taxWithheldPct: 24,
    reserveHoldbackPct: 5,
  },
  publishing_mechanical: {
    label: 'Publishing & mechanical',
    taxWithheldPct: 22,
    reserveHoldbackPct: 3,
  },
  sync_licensing: {
    label: 'Sync & licensing',
    taxWithheldPct: 28,
    reserveHoldbackPct: 8,
  },
};

const ADVANCE_RECOUPMENT = {
  'album-cycle-2024': {
    label: 'Album cycle 2024 advance',
    outstandingUsd: 18450,
    recoupmentRatePct: 35,
  },
  'tour-support': {
    label: 'Tour support advance',
    outstandingUsd: 7200,
    recoupmentRatePct: 20,
  },
  none: {
    label: 'No outstanding advance',
    outstandingUsd: 0,
    recoupmentRatePct: 0,
  },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Warner Music Group Royalty Portal vertical:',
  '- Service: `app/services/verticals/7a6ccff6.js`',
  '- Route: `app/routes/verticals/7a6ccff6.js`',
  '- Page: `app/public/verticals/7a6ccff6.html` (served at `/7a6ccff6`)',
  '- Rights registry: `app/services/verticals/features/7a6ccff6-rights-terms.json`',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function findEarningsSource(code) {
  return EARNINGS_SOURCES.find((source) => source.code === code) || EARNINGS_SOURCES[0];
}

function findAdvance(code) {
  return ADVANCE_RECOUPMENT[code] || ADVANCE_RECOUPMENT.none;
}

function getPeriodCloseDate(statementPeriod) {
  const quarterMatch = /^(\d{4})-Q([1-4])$/.exec(statementPeriod);

  if (quarterMatch) {
    const year = Number(quarterMatch[1]);
    const quarter = Number(quarterMatch[2]);
    return new Date(Date.UTC(year, quarter * 3, 0));
  }

  return new Date(statementPeriod);
}

function buildSettlementSchedule(source, statementPeriod) {
  const terms = RIGHTS_TERMS[source.rightsClass];
  const periodCloseDate = getPeriodCloseDate(statementPeriod);
  const settlementDate = new Date(
    periodCloseDate.getTime() + terms.settlementLagDays * 86400000,
  );

  return {
    statementPeriod,
    rightsClass: source.rightsClass,
    rightsLabel: terms.label,
    statementCycle: terms.statementCycle,
    periodCloseDate: periodCloseDate.toISOString(),
    settlementDate: settlementDate.toISOString(),
    settlementLagDays: terms.settlementLagDays,
  };
}

function computeNetPayout(source, advanceCode) {
  const withholding = WITHHOLDING_SCHEDULE[source.rightsClass];
  const terms = RIGHTS_TERMS[source.rightsClass];
  const advance = findAdvance(advanceCode);
  const artistShareUsd = Number(
    (source.grossEarningsUsd * terms.artistSharePct / 100).toFixed(2),
  );
  const taxWithheldUsd = Number(
    (artistShareUsd * withholding.taxWithheldPct / 100).toFixed(2),
  );
  const reserveHeldUsd = Number(
    (artistShareUsd * withholding.reserveHoldbackPct / 100).toFixed(2),
  );
  const advanceRecoupedUsd = Math.min(
    advance.outstandingUsd,
    Number((artistShareUsd * advance.recoupmentRatePct / 100).toFixed(2)),
  );
  const netPayoutUsd = Number(
    Math.max(
      0,
      artistShareUsd - taxWithheldUsd - reserveHeldUsd - advanceRecoupedUsd,
    ).toFixed(2),
  );

  return {
    artistShareUsd,
    taxWithheldUsd,
    reserveHeldUsd,
    advanceRecoupedUsd,
    netPayoutUsd,
  };
}

function buildPayoutResult(
  payoutReference,
  source,
  advance,
  schedule,
  payout,
  accountNumber,
  payoutMethod,
) {
  return {
    payoutReference,
    status: 'submitted',
    accountNumber,
    payoutMethod,
    earningsSource: {
      code: source.code,
      name: source.name,
      territory: source.territory,
      grossEarningsUsd: source.grossEarningsUsd,
    },
    advance: advance.label,
    settlement: schedule,
    payout,
    confirmationEmailQueued: true,
  };
}

async function requestPayout(data) {
  const startTime = Date.now();
  const payoutReference = `WMG-${uuidv4().slice(0, 8).toUpperCase()}`;

  const accountNumber = String(data.accountNumber || '').trim();
  const statementPeriod = String(data.statementPeriod || '').trim();

  if (!accountNumber || !statementPeriod) {
    const validationError = new Error('Enter your artist account number and statement period.');
    validationError.name = 'ValidationError';
    validationError.code = 'INVALID_PAYOUT_REQUEST';
    validationError.statusCode = 400;
    throw validationError;
  }

  logger.info('Requesting Warner Music Group royalty payout', {
    payoutReference,
    earningsSource: data.earningsSource,
    advance: data.advance,
    service: 'customer-7a6ccff6-royalty-payout',
    route: '/api/7a6ccff6/request-payout',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 90 + Math.random() * 140));

    const source = findEarningsSource(data.earningsSource);
    const advance = findAdvance(data.advance);
    const schedule = buildSettlementSchedule(source, statementPeriod);
    const payout = computeNetPayout(source, data.advance);
    const result = buildPayoutResult(
      payoutReference,
      source,
      advance,
      schedule,
      payout,
      accountNumber,
      data.payoutMethod || 'bank-transfer',
    );
    const duration = Date.now() - startTime;

    incrementMetric('royalty_payout.payout_success', {
      route: '/api/7a6ccff6/request-payout',
      earningsSource: source.code,
      advance: data.advance || 'album-cycle-2024',
    });
    recordTiming('royalty_payout.payout_latency', duration, {
      route: '/api/7a6ccff6/request-payout',
    });

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('royalty_payout.payout_failure', {
      route: '/api/7a6ccff6/request-payout',
      errorClass: error.name,
      earningsSource: data.earningsSource,
    });
    recordTiming('royalty_payout.payout_latency', duration, {
      route: '/api/7a6ccff6/request-payout',
      error: 'true',
    });

    logger.error('Royalty payout request failed', {
      payoutReference,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      earningsSource: data.earningsSource,
      advance: data.advance,
      service: 'customer-7a6ccff6-royalty-payout',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/7a6ccff6/request-payout',
        service: 'customer-7a6ccff6-royalty-payout',
        earningsSource: data.earningsSource,
      },
      extra: {
        payoutReference,
        advance: data.advance,
        statementPeriod,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/7a6ccff6.js — buildSettlementSchedule',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-7a6ccff6-royalty-payout',
      verticalLabel: 'Royalty Payout',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '7a6ccff6',
      slackMemberId: 'U0BL94AFWM7',
      tags: [
        { key: 'route', value: '/api/7a6ccff6/request-payout' },
        { key: 'service', value: 'customer-7a6ccff6-royalty-payout' },
        { key: 'earningsSource', value: data.earningsSource },
        { key: 'advance', value: data.advance },
      ],
      extra: {
        payoutReference,
        advance: data.advance,
        statementPeriod,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-7a6ccff6-royalty-payout@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for royalty payout error', {
        error: err.message,
        payoutReference,
      });
    });

    throw error;
  }
}

module.exports = {
  requestPayout,
  REMEDIATION_DIRECTIVE,
  EARNINGS_SOURCES,
  WITHHOLDING_SCHEDULE,
  ADVANCE_RECOUPMENT,
  RIGHTS_TERMS,
};
