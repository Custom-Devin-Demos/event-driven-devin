const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Advisory practices reachable through the engagement inquiry flow.
 */
const PRACTICES = {
  strategic_advisory: {
    code: 'strategic_advisory',
    name: 'Strategic Advisory',
    description: 'M&A, strategic and board advisory',
    desk: 'advisory',
  },
  strategic_defense: {
    code: 'strategic_defense',
    name: 'Strategic Defense and Shareholder Advisory',
    description: 'Activism defense and shareholder engagement',
    desk: 'advisory',
  },
  restructuring: {
    code: 'restructuring',
    name: 'Restructuring and Debt Advisory',
    description: 'Liability management and restructuring advice',
    desk: 'advisory',
  },
  equity_capital_markets: {
    code: 'equity_capital_markets',
    name: 'Equity Capital Markets',
    description: 'IPO, follow-on and equity-linked advisory',
    desk: 'capital_markets',
  },
  private_capital: {
    code: 'private_capital',
    name: 'Private Capital Advisory',
    description: 'Secondaries and private fund placement',
    desk: 'capital_markets',
  },
};

/**
 * Coverage profiles keyed by ISO country code. Each profile carries the
 * regulatory region and whether the mandate spans multiple jurisdictions.
 */
const COVERAGE_PROFILES = {
  US: { region: 'americas', currency: 'usd', crossBorder: false },
  CA: { region: 'americas', currency: 'cad', crossBorder: true },
  GB: { region: 'emea', currency: 'gbp', crossBorder: true },
  DE: { region: 'emea', currency: 'eur', crossBorder: true },
  JP: { region: 'apac', currency: 'jpy', crossBorder: true },
  SG: { region: 'apac', currency: 'sgd', crossBorder: true },
};

/**
 * Published engagement desks by coverage lane. Each desk carries the
 * indicative retainer and success-fee basis points used for the initial
 * engagement brief.
 */
const ENGAGEMENT_DESKS = {
  'advisory-domestic': { retainerBps: 8, successFeeBps: 95, label: 'Domestic strategic advisory desk' },
  'advisory-cross-border': { retainerBps: 10, successFeeBps: 110, label: 'Cross-border strategic advisory desk' },
  'capital_markets-domestic': { retainerBps: 6, successFeeBps: 80, label: 'Domestic capital markets desk' },
  'capital_markets-cross-border': { retainerBps: 7, successFeeBps: 90, label: 'Cross-border capital markets desk' },
};

/**
 * Transaction size tiers quoted during engagement inquiries.
 */
const MANDATE_TIERS = [
  { tier: 'mid-market', maxValueUsd: 500000000, seniorCoverage: 'managing-director' },
  { tier: 'large-cap', maxValueUsd: 5000000000, seniorCoverage: 'senior-managing-director' },
  { tier: 'mega-cap', maxValueUsd: Infinity, seniorCoverage: 'firm-leadership' },
];

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `Custom-Devin-Demos/event-driven-devin`',
  '',
  'The failing code path is the investment banking engagement inquiry vertical:',
  '- Service: `app/services/verticals/fa4d1e65.js`',
  '- Route: `app/routes/verticals/fa4d1e65.js`',
  '- Page: `app/public/verticals/fa4d1e65.html` (served at `/fa4d1e65`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function findPractice(code) {
  return PRACTICES[code] || null;
}

/**
 * Resolve the coverage profile for the inquiring client.
 */
function resolveCoverageProfile(region) {
  const key = String(region || 'US').toUpperCase();
  return COVERAGE_PROFILES[key] || COVERAGE_PROFILES.US;
}

/**
 * Build the engagement lane identifier for a practice and coverage pairing.
 */
function buildEngagementLane(practice, profile) {
  const scope = profile.crossBorder ? 'cross-border' : 'domestic';
  return `${practice.desk}-${scope}`;
}

/**
 * Resolve the mandate tier for the inquiry's indicative transaction value.
 */
function resolveMandateTier(transactionValueUsd) {
  const value = Number(transactionValueUsd) || 100000000;
  return MANDATE_TIERS.find((entry) => value <= entry.maxValueUsd) || MANDATE_TIERS[0];
}

/**
 * Build the fee indication for the engagement brief: desk assignment,
 * indicative economics and the coverage level committed to the mandate.
 */
function buildFeeIndication(practice, profile, mandateTier) {
  const lane = buildEngagementLane(practice, profile);
  const desk = ENGAGEMENT_DESKS[lane] || ENGAGEMENT_DESKS['advisory-domestic'];

  return {
    lane,
    deskLabel: desk.label,
    currency: profile.currency,
    retainerBps: desk.retainerBps,
    successFeeBps: desk.successFeeBps,
    seniorCoverage: mandateTier.seniorCoverage,
    mandateTier: mandateTier.tier,
  };
}

/**
 * Build the confirmation payload returned to the marketing site.
 */
function buildEngagementBrief(referenceNumber, practice, profile, feeIndication) {
  return {
    success: true,
    referenceNumber,
    status: 'received',
    practice: practice.name,
    practiceDescription: practice.description,
    region: profile.region,
    feeIndication,
    followUpWithinHours: 24,
    receivedAt: new Date().toISOString(),
  };
}

/**
 * Handle an engagement inquiry submitted from the marketing site.
 */
async function submitEngagement(data) {
  const startTime = Date.now();
  const referenceNumber = uuidv4();

  const practice = findPractice(data.practice) || PRACTICES.strategic_advisory;

  logger.info('Processing engagement inquiry', {
    referenceNumber,
    practice: practice.code,
    region: data.region,
    service: 'customer-fa4d1e65-engagement',
    route: '/api/fa4d1e65/engagement',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const profile = resolveCoverageProfile(data.region);
    const mandateTier = resolveMandateTier(data.transactionValueUsd);
    const feeIndication = buildFeeIndication(practice, profile, mandateTier);
    const brief = buildEngagementBrief(referenceNumber, practice, profile, feeIndication);

    const duration = Date.now() - startTime;

    incrementMetric('engagement_inquiry.success', {
      route: '/api/fa4d1e65/engagement',
      practice: practice.code,
    });
    recordTiming('engagement_inquiry.latency', duration, {
      route: '/api/fa4d1e65/engagement',
    });

    return brief;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('engagement_inquiry.failure', {
      route: '/api/fa4d1e65/engagement',
      errorClass: error.name,
      practice: practice.code,
    });
    recordTiming('engagement_inquiry.latency', duration, {
      route: '/api/fa4d1e65/engagement',
      error: 'true',
    });

    logger.error('Engagement inquiry failed', {
      referenceNumber,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      practice: practice.code,
      region: data.region,
      service: 'customer-fa4d1e65-engagement',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/fa4d1e65/engagement',
        service: 'customer-fa4d1e65-engagement',
        practice: practice.code,
      },
      extra: {
        referenceNumber,
        practice: practice.code,
        region: data.region,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/fa4d1e65.js \u2014 buildFeeIndication',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-fa4d1e65-engagement',
      verticalLabel: 'Investment Banking Engagement Inquiry',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 'fa4d1e65',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/fa4d1e65/engagement' },
        { key: 'service', value: 'customer-fa4d1e65-engagement' },
        { key: 'practice', value: practice.code },
        { key: 'region', value: data.region },
      ],
      extra: {
        referenceNumber,
        practice: practice.code,
        region: data.region,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-fa4d1e65-engagement@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for engagement inquiry error', {
        error: err.message,
        referenceNumber,
      });
    });

    throw error;
  }
}

module.exports = {
  submitEngagement,
  REMEDIATION_DIRECTIVE,
  PRACTICES,
  COVERAGE_PROFILES,
  ENGAGEMENT_DESKS,
  MANDATE_TIERS,
  resolveCoverageProfile,
  buildEngagementLane,
  resolveMandateTier,
  buildFeeIndication,
};
