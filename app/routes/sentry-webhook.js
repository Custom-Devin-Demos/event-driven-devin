const express = require('express');
const logger = require('../telemetry/logger');
const { createSessionAndAlert } = require('../services/devin-session');
const { verifySentrySignature } = require('../middleware/verify-session-secret');
const { PORTAL_REMEDIATION_DIRECTIVE } = require('../services/verticals/5b992ae7');
const { APP_REMEDIATION_DIRECTIVE } = require('../services/verticals/3aa9fa04');

const router = express.Router();

/**
 * Extract issue details from various Sentry webhook payload formats.
 *
 * Sentry sends different shapes depending on the source:
 *   1. Issue Alert webhooks (Sentry-Hook-Resource: event_alert)
 *      - action: "triggered", data.event, data.event.issue_url, data.triggered_rule
 *   2. Issue webhooks (Sentry-Hook-Resource: issue)
 *      - action: "created"/"resolved"/etc, data.issue with url, web_url, title, metadata
 *   3. Metric Alert webhooks
 *      - data.metric_alert
 *   4. Legacy webhook plugin (top-level fields)
 */
function extractAlertData(payload) {
  // 1. Issue Alert (action = "triggered", data.event present)
  if (payload.action === 'triggered' && payload.data && payload.data.event) {
    const event = payload.data.event;
    const issueId = event.issue_id || '';
    const tags = event.tags || [];

    return {
      issueTitle: event.title || 'Unknown error',
      issueUrl: event.web_url || event.url || (issueId ? `https://sentry.io/issues/${issueId}/` : ''),
      culprit: event.culprit || '',
      errorType: event.type || '',
      errorValue: event.metadata?.value || event.message || '',
      tags: Array.isArray(tags) ? tags : [],
      extra: event.extra || event.contexts || {},
      level: event.level || '',
      platform: event.platform || '',
      firstSeen: '',
      lastSeen: event.datetime || '',
      count: '',
      shortId: '',
      project: event.project || '',
      release: event.release?.version || event.release || '',
      environment: event.environment || '',
      triggeredRule: payload.data.triggered_rule || '',
    };
  }

  // 2. Issue webhook (data.issue present — from "issue" checkbox in integration)
  if (payload.data && payload.data.issue) {
    const issue = payload.data.issue;
    const event = payload.data.event || {};
    const tags = event.tags || issue.tags || [];

    return {
      issueTitle: issue.title || event.title || 'Unknown error',
      issueUrl: issue.web_url || issue.permalink || `https://sentry.io/issues/${issue.id}/`,
      culprit: issue.culprit || event.culprit || '',
      errorType: issue.type || issue.metadata?.type || event.type || '',
      errorValue: issue.metadata?.value || event.message || '',
      tags: Array.isArray(tags) ? tags : [],
      extra: event.extra || event.contexts || {},
      level: issue.level || event.level || '',
      platform: issue.platform || event.platform || '',
      firstSeen: issue.firstSeen || '',
      lastSeen: issue.lastSeen || '',
      count: issue.count || '',
      shortId: issue.shortId || '',
      project: issue.project?.slug || issue.project?.name || '',
      release: event.release?.version || '',
      environment: event.environment || '',
      triggeredRule: '',
    };
  }

  // 3. Metric Alert (payload.data.metric_alert)
  if (payload.data && payload.data.metric_alert) {
    const alert = payload.data.metric_alert;
    return {
      issueTitle: alert.title || alert.alert_rule?.name || 'Metric alert triggered',
      issueUrl: '',
      culprit: '',
      errorType: 'MetricAlert',
      errorValue: `${alert.title} — status: ${alert.status}`,
      tags: [],
      extra: { description: alert.description || '' },
      level: 'error',
      platform: '',
      firstSeen: '',
      lastSeen: alert.date_triggered || '',
      count: '',
      shortId: '',
      project: '',
      release: '',
      environment: '',
      triggeredRule: alert.alert_rule?.name || '',
    };
  }

  // 4. Fallback: try to extract whatever is available
  return {
    issueTitle: payload.message || payload.title || payload.culprit || 'Sentry alert',
    issueUrl: payload.url || '',
    culprit: payload.culprit || '',
    errorType: payload.event?.type || payload.type || '',
    errorValue: payload.event?.message || payload.message || '',
    tags: payload.event?.tags || payload.tags || [],
    extra: payload.event?.extra || payload.event?.contexts || {},
    level: payload.level || payload.event?.level || '',
    platform: payload.platform || payload.event?.platform || '',
    firstSeen: '',
    lastSeen: payload.datetime || '',
    count: '',
    shortId: '',
    project: payload.project || payload.project_slug || '',
    release: payload.release || '',
    environment: payload.environment || '',
    triggeredRule: '',
  };
}

/**
 * SEV-1 synthetic probes tag the Sentry events they generate with
 * `synthetic_probe`. Those events are demo evidence for the incident-agent
 * flow, not new production errors, so they never spawn a Devin session.
 */
function isSyntheticProbeEvent(alertData) {
  return (alertData.tags || []).some((tag) => {
    if (Array.isArray(tag)) return tag[0] === 'synthetic_probe';
    if (tag && typeof tag === 'object') {
      return tag.key === 'synthetic_probe' || 'synthetic_probe' in tag;
    }
    return false;
  });
}

/**
 * Errors raised on the on-call demo slice (`/api/oncall/...` routes) belong to
 * the on-call incident flow — the responders are driven by the alert cards
 * posted to the on-call channels, never by the legacy Slack-alert/Devin
 * pipeline. The legacy verticals are untouched: their errors carry
 * `/api/<vertical>/...` routes and still flow through.
 */
function isOncallSliceEvent(alertData) {
  const tagValues = (alertData.tags || []).flatMap((tag) => {
    if (Array.isArray(tag)) return tag;
    if (tag && typeof tag === 'object') return Object.values(tag);
    return [tag];
  });
  // Payload shapes vary: the route tag is the primary signal, but issue-shaped
  // payloads may carry no event tags, leaving only culprit/title/url — those
  // reference the service module (oncall-verticals) rather than the route.
  return [alertData.culprit, alertData.issueTitle, alertData.issueUrl, ...tagValues].some(
    (value) => typeof value === 'string'
      && (value.toLowerCase().includes('/api/oncall/') || value.toLowerCase().includes('oncall-verticals')),
  );
}

function alertSearchableText(alertData) {
  const tagValues = (alertData.tags || []).flatMap((tag) => {
    if (Array.isArray(tag)) return tag;
    if (tag && typeof tag === 'object') return Object.values(tag);
    return [tag];
  });
  return [alertData.culprit, ...tagValues]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function applyUnicajaBranding(alertData) {
  const searchableText = alertSearchableText(alertData);

  if (
    searchableText.includes('customer-unicaja-digital-access')
    || searchableText.includes('unicaja')
  ) {
    return {
      ...alertData,
      customer: 'unicaja',
      verticalLabel: 'Unicaja Banca Digital',
      devinEmail: alertData.devinEmail,
      release: 'unicaja-banca-digital@1.0.0',
    };
  }

  return alertData;
}

// Sentry stamps every event with the deployment-wide identity of this app
// (`beforeSend` in app/telemetry/sentry.js, plus SENTRY_RELEASE / DD_SERVICE on
// the host). Customer-specific verticals send their own identity on the event,
// so overwrite the deployment-wide values with the vertical's own before the
// alert reaches the investigation prompt.
const CUSTOMER_ALERT_IDENTITY = {
  '4f645972': {
    customer: '4f645972',
    verticalLabel: 'Claims Estimate',
    service: 'customer-4f645972-claims',
    project: 'claims-portal',
    release: 'claims-portal@1.0.0',
    tagOverrides: {
      customer: 'claims-portal',
      service: 'customer-4f645972-claims',
      tenant: 'claims',
      scenario: 'claim-estimate',
    },
  },
  '6f43e66c': {
    customer: '6f43e66c',
    verticalLabel: 'Consumer Zelle Send',
    service: 'customer-6f43e66c-zelle-send',
    project: 'event-driven-devin',
    release: 'customer-6f43e66c-zelle-send@1.0.0',
    tagOverrides: {
      customer: '6f43e66c',
      service: 'customer-6f43e66c-zelle-send',
      route: '/api/6f43e66c/send',
      scenario: 'zelle-send',
    },
  },
  // Flutter customer portal (github.com/Custom-Devin-Demos/ge-customer-portal).
  // Its events arrive from the app's own Sentry project, not from this host,
  // and remediation lands in the Flutter repo — the directive names it.
  '5b992ae7': {
    customer: '5b992ae7',
    verticalLabel: 'GE Aerospace Customer Portal',
    service: 'customer-5b992ae7-portal',
    project: 'ge-customer-portal',
    release: 'ge-customer-portal@1.0.0',
    promptAppendix: PORTAL_REMEDIATION_DIRECTIVE,
    tagOverrides: {
      customer: 'customer-5b992ae7-portal',
      service: 'customer-5b992ae7-portal',
      scenario: 'technical-inquiry',
    },
  },
  // Splash Sports Expo app (github.com/COG-GTM/splash-sports-mobile). Reports
  // arrive via /api/3aa9fa04/app/error; remediation lands in the mobile repo.
  '3aa9fa04': {
    customer: '3aa9fa04',
    verticalLabel: 'Splash Sports Mobile',
    service: 'customer-3aa9fa04-mobile',
    project: 'splash-sports-mobile',
    release: 'splash-sports-mobile@1.0.0',
    promptAppendix: APP_REMEDIATION_DIRECTIVE,
    tagOverrides: {
      customer: 'customer-3aa9fa04-mobile',
      service: 'customer-3aa9fa04-mobile',
      scenario: 'nfl-primetime-entry',
    },
  },
};

function tagKey(tag) {
  if (Array.isArray(tag)) return tag[0];
  if (tag && typeof tag === 'object') return tag.key;
  return undefined;
}

function applyCustomerIdentity(alertData) {
  const searchableText = alertSearchableText(alertData);
  // Match on the entry's full service identity (emitted in the service tag,
  // e.g. `customer-4f645972-claims`) so a bare or word-like slug can never
  // rewrite the identity of an unrelated customer's alert, and so two surfaces
  // of the same customer (e.g. `customer-5b992ae7-inquiry` on this host vs
  // `customer-5b992ae7-portal` in the Flutter app) never claim each other.
  const slug = Object.keys(CUSTOMER_ALERT_IDENTITY)
    .find((id) => searchableText.includes(CUSTOMER_ALERT_IDENTITY[id].service));

  if (!slug) return alertData;

  const { tagOverrides, ...fields } = CUSTOMER_ALERT_IDENTITY[slug];
  const overridden = new Set(Object.keys(tagOverrides));
  // Sentry issue-alert webhooks deliver tags as [key, value] arrays while the
  // instant path uses { key, value } objects; normalize so overridden tags are
  // replaced (not duplicated) regardless of shape.
  const tags = (alertData.tags || [])
    .filter((tag) => !overridden.has(tagKey(tag)))
    .concat(Object.entries(tagOverrides).map(([key, value]) => ({ key, value })));

  return { ...alertData, ...fields, tags };
}

/**
 * POST /webhooks/sentry — Receive Sentry alert webhooks and create
 * a Devin session to investigate the error automatically.
 */
router.post('/webhooks/sentry', verifySentrySignature, async (req, res) => {
  const payload = req.body;

  // Sentry sends a POST with action: "verification" when first setting up.
  if (payload.action === 'verification') {
    logger.info('Sentry webhook verification request received');
    return res.json({ received: true, verification: true });
  }

  const action = payload.action || '';
  const hookResource = req.headers['sentry-hook-resource'] || 'unknown';

  logger.info('Sentry webhook received', {
    action,
    actor: payload.actor?.name || 'system',
    hookResource,
  });

  // Only create Devin sessions for actionable alert events.
  // Skip resolved/ignored/assigned/etc — those are status changes, not new errors.
  const actionableActions = ['triggered', 'created', 'critical', 'warning'];
  if (!actionableActions.includes(action)) {
    logger.info('Sentry webhook skipped — non-actionable action', { action, hookResource });
    return res.json({ received: true, skipped: true, reason: `action_${action}_not_actionable` });
  }

  try {
    const alertData = applyCustomerIdentity(applyUnicajaBranding(extractAlertData(payload)));

    if (isSyntheticProbeEvent(alertData)) {
      logger.info('Sentry webhook skipped — synthetic probe event', {
        issueTitle: alertData.issueTitle,
      });
      return res.json({ received: true, skipped: true, reason: 'synthetic_probe' });
    }

    if (isOncallSliceEvent(alertData)) {
      logger.info('Sentry webhook skipped — on-call slice event', {
        issueTitle: alertData.issueTitle,
      });
      return res.json({ received: true, skipped: true, reason: 'oncall_slice' });
    }

    // If a devinUserId/devinOrgId was forwarded via query param (e.g. from the instant path),
    // attach it so the Devin session is created under the correct user/org.
    if (req.query.devinUserId) {
      alertData.devinUserId = req.query.devinUserId;
    }
    if (req.query.devinOrgId) {
      alertData.devinOrgId = req.query.devinOrgId;
    }
    if (req.query.devinEmail) {
      alertData.devinEmail = req.query.devinEmail;
    }

    const result = await createSessionAndAlert(alertData);

    if (!result) {
      return res.json({ received: true, skipped: true, reason: 'error' });
    }

    return res.json({
      received: true,
      devinSession: result,
    });
  } catch (error) {
    logger.error('Sentry webhook processing failed', {
      error: error.message,
    });

    return res.status(502).json({
      received: true,
      error: 'Failed to process webhook',
      details: error.message,
    });
  }
});

module.exports = router;
module.exports.applyCustomerIdentity = applyCustomerIdentity;
