const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

// Sanctions lists the screening engine matches against, each with the release
// policy that applies once a hit on that list is cleared as a false positive.
const SCREENING_LISTS = {
  un_consolidated: {
    label: 'UN Security Council consolidated list',
    releasePolicy: { requiredApprovals: 2, releaseRail: 'SWIFT gpi', holdReasonCode: 'SAN-UN' },
  },
  ofac_sdn: {
    label: 'OFAC Specially Designated Nationals',
    releasePolicy: { requiredApprovals: 2, releaseRail: 'SWIFT gpi', holdReasonCode: 'SAN-OFAC' },
  },
  eu_consolidated: {
    label: 'EU consolidated financial sanctions list',
    releasePolicy: { requiredApprovals: 2, releaseRail: 'SWIFT gpi', holdReasonCode: 'SAN-EU' },
  },
};

/**
 * One tenant per demo owner. Each tenant owns the held payment that carries
 * the demo failure and its own screening list key, so registering one
 * tenant's list leaves every other tenant's release failing as before.
 *
 * There is deliberately no shared or default tenant: the vertical is reachable
 * only at /ebde8c43/<slug>. Add an owner with an entry here and an unused
 * screening list key.
 */
const TENANTS = {
  nouf: {
    slug: 'nouf',
    label: 'Transaction Screening — Release held payment (Nouf)',
    alert: {
      alertId: 'TS-ALR-2026-104382',
      messageRef: 'MT103-RYD-88410273',
      amount: 482750,
      currency: 'SAR',
      approvals: 2,
      disposition: 'false_positive',
      // the domestic watchlist added to the cross-border SWIFT template in 2026
      screeningList: 'sama_domestic_watchlist_nouf',
    },
  },
};

function getTenant(slug) {
  const key = String(slug || '').trim().toLowerCase();
  return Object.hasOwn(TENANTS, key) ? TENANTS[key] : undefined;
}

function routeTag(tenant) {
  return `/api/ebde8c43/${tenant.slug}/release`;
}

const SLACK_MEMBER_ID = process.env.SLACK_MEMBER_ID_EBDE8C43 || '';

const SENTRY_ISSUE_QUERY = 'is:unresolved releasePolicy';

const REMEDIATION_DIRECTIVE = `Repository: COG-GTM/event-driven-devin. Scope: only the held payment release failure below. This repository hosts many independent demo verticals, each with its own intentional bug and its own Sentry issues; ignore every issue that is not from the release route named in the alert's route tag and do not modify any other vertical. The failing surface is the transaction screening console at app/public/verticals/ebde8c43.html, served per demo owner at GET /ebde8c43/<tenant>, whose "Release payment" action posts to POST /api/ebde8c43/<tenant>/release in app/routes/verticals/ebde8c43.js. The release pipeline lives in app/services/verticals/ebde8c43.js: releaseHeldPayment -> buildRelease -> resolveReleasePolicy. resolveReleasePolicy looks up SCREENING_LISTS by the screening list on the held payment's alert, so an alert raised on a list with no registered release policy cannot be released. Use the list named in the alert's screening_list tag as the remediation target: register that list (label and release policy: required approvals, release rail, hold reason code) and keep unregistered lists failing as a handled configuration error rather than a TypeError. Verify by starting the server (node app/server.js) and releasing the affected tenant's payment, which must return a successful release, and confirm npm run lint and npm test pass.

The release surface is served per demo owner: every tenant declared in TENANTS is reachable only at /ebde8c43/<slug> with POST /api/ebde8c43/<slug>/release, and there is no shared or default tenant. Each tenant owns its own held payment and screening list key, so register only the list named in the alert's screening_list tag and leave every other tenant untouched.

Verification evidence is mandatory and must be visual, not curl-only: with the server running, open the console for the affected tenant in a real browser, click "Release payment", and record your screen for the whole attempt so the recording shows the held payment, the click, and the successful release that replaces the previous error. Attach a screenshot and an animated webp of the recording to the pull request under a "Fix Verification" heading.`;

function validationError(message, code) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = 400;
  return error;
}

function resolveReleasePolicy(alert) {
  return SCREENING_LISTS[alert.screeningList].releasePolicy;
}

function buildRelease(alert, amount) {
  const policy = resolveReleasePolicy(alert);

  if (alert.approvals < policy.requiredApprovals) {
    throw validationError('Release needs another approval', 'APPROVAL_REQUIRED');
  }

  return {
    releaseId: `REL-${uuidv4().replace(/-/g, '').slice(0, 10).toUpperCase()}`,
    alertId: alert.alertId,
    messageRef: alert.messageRef,
    amount,
    currency: alert.currency,
    rail: policy.releaseRail,
    holdReasonCode: policy.holdReasonCode,
    releasedAt: new Date().toISOString(),
  };
}

async function releaseHeldPayment(data) {
  const startTime = Date.now();
  const tenant = getTenant(data.tenant);

  if (!tenant) {
    throw validationError(`Unknown release tenant "${data.tenant}"`, 'UNKNOWN_TENANT');
  }

  const { alert } = tenant;
  if (data.alertId && data.alertId !== alert.alertId) {
    throw validationError('Unknown held payment', 'UNKNOWN_ALERT');
  }

  const amount = Number(data.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > alert.amount) {
    throw validationError('Release amount must be above zero and no more than the held amount', 'INVALID_AMOUNT');
  }

  logger.info('Releasing held payment', {
    alertId: alert.alertId,
    screeningList: alert.screeningList,
    service: 'screening-release-api',
    route: routeTag(tenant),
  });

  try {
    const release = buildRelease(alert, amount);
    recordTiming('screening.release.latency', Date.now() - startTime, { route: routeTag(tenant) });
    incrementMetric('screening.release.success', { route: routeTag(tenant) });
    return { success: true, release };
  } catch (error) {
    if (error.statusCode === 400) throw error;
    const duration = Date.now() - startTime;

    incrementMetric('screening.release.failure', {
      route: routeTag(tenant),
      errorClass: error.name,
      screeningList: alert.screeningList,
    });
    recordTiming('screening.release.latency', duration, { route: routeTag(tenant), error: 'true' });

    logger.error('Held payment release failed', {
      alertId: alert.alertId,
      screeningList: alert.screeningList,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: 'screening-release-api',
    });

    Sentry.captureException(error, {
      tags: {
        route: routeTag(tenant),
        service: 'screening-release-api',
        screening_list: alert.screeningList,
        alert_path: 'instant',
      },
      extra: { alertId: alert.alertId, screeningList: alert.screeningList },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=${encodeURIComponent(SENTRY_ISSUE_QUERY)}`,
      culprit: 'app/services/verticals/ebde8c43.js — resolveReleasePolicy',
      errorType: error.name || 'Error',
      errorValue: error.message,
      service: 'screening-release-api',
      verticalLabel: tenant.label,
      customer: 'ebde8c43',
      slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: [
        { key: 'route', value: routeTag(tenant) },
        { key: 'service', value: 'screening-release-api' },
        { key: 'screening_list', value: alert.screeningList },
      ],
      extra: { alertId: alert.alertId, screeningList: alert.screeningList },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'screening-release-api@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for release error', {
        alertId: alert.alertId,
        error: alertError.message,
      });
    });

    throw error;
  }
}

module.exports = {
  releaseHeldPayment,
  buildRelease,
  resolveReleasePolicy,
  getTenant,
  TENANTS,
  SCREENING_LISTS,
  REMEDIATION_DIRECTIVE,
};
