const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Donation frequency options and their annualised multiplier
 * (used to project the yearly value of a recurring gift).
 */
const FREQUENCIES = {
  once: { label: 'Single donation', annualMultiplier: 1 },
  monthly: { label: 'Monthly donation', annualMultiplier: 12 },
};

/**
 * Active humanitarian appeals. Each appeal carries an `allocation`
 * profile describing how every franc is split across field
 * programmes, logistics and running costs, plus a `unitCost` used
 * to translate a gift into a tangible impact figure.
 */
const APPEALS = [
  {
    id: 'middle-east',
    name: 'Middle East Crisis',
    region: 'Gaza, Lebanon & the region',
    allocation: { field: 0.87, logistics: 0.09, support: 0.04 },
    unitCost: 45,
    unitLabel: 'family food parcels',
  },
  {
    id: 'ukraine',
    name: 'Ukraine Armed Conflict',
    region: 'Ukraine',
    allocation: { field: 0.85, logistics: 0.11, support: 0.04 },
    unitCost: 60,
    unitLabel: 'winter survival kits',
  },
  {
    id: 'sudan',
    name: 'Sudan Emergency',
    region: 'Sudan',
    allocation: { field: 0.88, logistics: 0.08, support: 0.04 },
    unitCost: 30,
    unitLabel: 'clean-water rations',
  },
  {
    id: 'dr-congo',
    name: 'DR Congo Emergency',
    region: 'Democratic Republic of the Congo',
    allocation: { field: 0.86, logistics: 0.10, support: 0.04 },
    unitCost: 40,
    unitLabel: 'emergency health consultations',
  },
  {
    id: 'myanmar',
    name: 'Myanmar Earthquake',
    region: 'Myanmar',
    allocation: { field: 0.84, logistics: 0.12, support: 0.04 },
    unitCost: 55,
    unitLabel: 'shelter tool kits',
  },
  {
    id: 'where-needed',
    name: 'Where the need is greatest',
    region: 'Global operations',
    unitCost: 50,
    unitLabel: 'lifesaving aid packages',
  },
];

function findAppeal(appealId) {
  return APPEALS.find((a) => a.id === appealId) || APPEALS[0];
}

/**
 * Resolve the allocation profile for an appeal. Unrestricted appeals
 * pool into general operations and are directed by field teams.
 */
function getAllocationProfile(appeal) {
  return appeal.allocation;
}

/**
 * Break a gift down across field programmes, logistics and running
 * costs using the appeal's allocation profile.
 */
function buildAllocationBreakdown(appeal, amount) {
  const profile = getAllocationProfile(appeal);

  return {
    field: Math.round(amount * profile.field * 100) / 100,
    logistics: Math.round(amount * profile.logistics * 100) / 100,
    support: Math.round(amount * profile.support * 100) / 100,
    fieldPct: Math.round(profile.field * 100),
  };
}

/**
 * Assemble the donation confirmation summary returned to the donor.
 */
function assembleDonationSummary(appeal, frequency, amount, breakdown) {
  const freq = FREQUENCIES[frequency] || FREQUENCIES.once;
  const annualValue = Math.round(amount * freq.annualMultiplier * 100) / 100;
  const unitsFunded = Math.floor(amount / appeal.unitCost);

  return {
    receiptId: `ICRC-${uuidv4().slice(0, 8).toUpperCase()}`,
    appeal: appeal.name,
    region: appeal.region,
    frequency: freq.label,
    amount: Math.round(amount * 100) / 100,
    currency: 'CHF',
    annualValue,
    toField: breakdown.field,
    toLogistics: breakdown.logistics,
    toSupport: breakdown.support,
    fieldPct: breakdown.fieldPct,
    impact: `${unitsFunded} ${appeal.unitLabel}`,
    taxDeductible: true,
  };
}

/**
 * Processes a donation request.
 */
async function processDonation(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Processing donation', {
    requestId,
    appealId: data.appealId,
    frequency: data.frequency,
    amount: data.amount,
    service: 'customer-9309cd53-donations',
    route: '/api/9309cd53/donate',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const appeal = findAppeal(data.appealId);
    const breakdown = buildAllocationBreakdown(appeal, data.amount);
    const summary = assembleDonationSummary(appeal, data.frequency, data.amount, breakdown);

    summary.requestId = requestId;
    summary.donatedAt = new Date().toISOString();

    const duration = Date.now() - startTime;

    incrementMetric('donation.success', {
      route: '/api/9309cd53/donate',
      appeal: data.appealId,
    });
    recordTiming('donation.latency', duration, {
      route: '/api/9309cd53/donate',
    });

    return summary;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('donation.failure', {
      route: '/api/9309cd53/donate',
      errorClass: error.name,
    });
    recordTiming('donation.latency', duration, {
      route: '/api/9309cd53/donate',
      error: 'true',
    });

    logger.error('Donation failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      appealId: data.appealId,
      amount: data.amount,
      service: 'customer-9309cd53-donations',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/9309cd53/donate',
        service: 'customer-9309cd53-donations',
        appeal: data.appealId,
      },
      extra: { requestId, appealId: data.appealId, amount: data.amount },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/9309cd53.js — buildAllocationBreakdown',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-9309cd53-donations',
      verticalLabel: 'Donation Checkout',
      customer: '9309cd53',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/9309cd53/donate' },
        { key: 'service', value: 'customer-9309cd53-donations' },
        { key: 'appeal', value: data.appealId },
      ],
      extra: { requestId, appealId: data.appealId, amount: data.amount },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-9309cd53-donations@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for donation error', {
        error: err.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = { processDonation, APPEALS, FREQUENCIES };
