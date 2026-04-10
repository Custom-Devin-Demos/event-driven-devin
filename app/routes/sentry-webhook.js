const express = require('express');
const logger = require('../telemetry/logger');
const { createSessionAndAlert } = require('../services/devin-session');
const { verifySentrySignature } = require('../middleware/verify-session-secret');

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
    const alertData = extractAlertData(payload);

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
