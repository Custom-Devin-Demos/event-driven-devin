const express = require('express');
const axios = require('axios');
const logger = require('../telemetry/logger');

const router = express.Router();

const DEVIN_API_BASE = 'https://api.devin.ai/v3';

/**
 * Build a rich investigation prompt from Sentry alert data.
 */
function buildPrompt(alertData) {
  const { issueTitle, issueUrl, culprit, errorType, errorValue, tags, extra } = alertData;

  const tagLines = tags && tags.length > 0
    ? tags.map((t) => `  - ${t.key}: ${t.value}`).join('\n')
    : '  (none)';

  const extraLines = extra && Object.keys(extra).length > 0
    ? Object.entries(extra).map(([k, v]) => `  - ${k}: ${v}`).join('\n')
    : '';

  return [
    'A Sentry alert just fired for the checkout-api service. Investigate this error immediately.',
    '',
    `**Error:** ${issueTitle}`,
    culprit ? `**Location:** ${culprit}` : '',
    errorType ? `**Type:** ${errorType}` : '',
    errorValue ? `**Message:** ${errorValue}` : '',
    issueUrl ? `**Sentry Issue:** ${issueUrl}` : '',
    '',
    'Tags:',
    tagLines,
    extraLines ? `\nExtra context:\n${extraLines}` : '',
    '',
    'Investigation steps:',
    '1. Use your Sentry MCP integration to look at this issue — examine the full stack trace, breadcrumbs, and affected releases.',
    '2. Use your Datadog MCP integration to check APM traces for the checkout-api service around the time of this error. Look at error rates, latency spikes, and correlated logs.',
    '3. Look at the source code in the COG-GTM/event-driven-devin repository to find the root cause. The error is in the checkout flow.',
    '4. Identify the exact line of code causing the issue and explain the root cause.',
    '5. Propose a fix (as a PR if possible) that resolves the error without breaking existing functionality.',
    '',
    'Repository: https://github.com/COG-GTM/event-driven-devin',
    'Service: checkout-api',
    'Environment: demo',
  ].filter(Boolean).join('\n');
}

/**
 * Extract issue details from various Sentry webhook payload formats.
 * Sentry sends different shapes depending on whether it is an
 * Issue Alert, Metric Alert, or the legacy webhook integration.
 */
function extractAlertData(payload) {
  // Issue Alert (action = "triggered", data.issue present)
  if (payload.data && payload.data.issue) {
    const issue = payload.data.issue;
    const event = payload.data.event || {};
    const tags = event.tags || issue.tags || [];

    return {
      issueTitle: issue.title || 'Unknown error',
      issueUrl: issue.permalink || `https://sentry.io/issues/${issue.id}/`,
      culprit: issue.culprit || event.culprit || '',
      errorType: issue.type || event.type || '',
      errorValue: issue.metadata?.value || event.message || '',
      tags: Array.isArray(tags) ? tags : [],
      extra: event.extra || {},
    };
  }

  // Metric Alert (payload.data.metric_alert)
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
    };
  }

  // Legacy / simple webhook (top-level fields)
  return {
    issueTitle: payload.message || payload.title || 'Sentry alert',
    issueUrl: payload.url || '',
    culprit: payload.culprit || '',
    errorType: payload.event?.type || '',
    errorValue: payload.event?.message || payload.message || '',
    tags: payload.event?.tags || [],
    extra: payload.event?.extra || {},
  };
}

/**
 * POST /webhooks/sentry — Receive Sentry alert webhooks and create
 * a Devin session to investigate the error automatically.
 */
router.post('/webhooks/sentry', async (req, res) => {
  const apiKey = process.env.DEVIN_API_KEY;
  const orgId = process.env.DEVIN_ORG_ID;

  if (!apiKey || !orgId) {
    logger.error('Sentry webhook received but DEVIN_API_KEY or DEVIN_ORG_ID not configured');
    return res.status(500).json({ error: 'Devin API not configured' });
  }

  const payload = req.body;

  // Sentry sends a POST with action: "verification" when first setting up
  if (payload.action === 'verification') {
    logger.info('Sentry webhook verification request received');
    return res.json({ received: true, verification: true });
  }

  logger.info('Sentry webhook received', {
    action: payload.action,
    actor: payload.actor?.name || 'system',
  });

  try {
    const alertData = extractAlertData(payload);
    const prompt = buildPrompt(alertData);

    logger.info('Creating Devin session for Sentry alert', {
      issueTitle: alertData.issueTitle,
      issueUrl: alertData.issueUrl,
    });

    const response = await axios.post(
      `${DEVIN_API_BASE}/organizations/${orgId}/sessions`,
      { prompt },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    const session = response.data;

    logger.info('Devin session created successfully', {
      sessionId: session.session_id,
      sessionUrl: session.url,
      issueTitle: alertData.issueTitle,
    });

    return res.json({
      received: true,
      devinSession: {
        sessionId: session.session_id,
        url: session.url,
        status: session.status,
      },
    });
  } catch (error) {
    logger.error('Failed to create Devin session', {
      error: error.message,
      status: error.response?.status,
      data: error.response?.data,
    });

    return res.status(502).json({
      received: true,
      error: 'Failed to create Devin session',
      details: error.message,
    });
  }
});

module.exports = router;
