const express = require('express');
const axios = require('axios');
const logger = require('../telemetry/logger');

const router = express.Router();

const DEVIN_API_BASE = 'https://api.devin.ai/v3';

/**
 * Build a rich investigation prompt from Sentry alert data.
 * Includes every detail available so Devin has full context.
 */
function buildPrompt(alertData) {
  const {
    issueTitle, issueUrl, culprit, errorType, errorValue,
    tags, extra, level, platform, firstSeen, lastSeen,
    count, shortId, project, release, environment, triggeredRule,
  } = alertData;

  const tagLines = tags && tags.length > 0
    ? tags.map((t) => {
      const key = t.key || t[0] || '';
      const value = t.value || t[1] || '';
      return `  - ${key}: ${value}`;
    }).join('\n')
    : '  (none available in webhook payload — check Sentry MCP for full tags)';

  const extraLines = extra && Object.keys(extra).length > 0
    ? Object.entries(extra).map(([k, v]) => `  - ${k}: ${JSON.stringify(v)}`).join('\n')
    : '';

  const lines = [
    'A Sentry alert just fired for the checkout-api service. Investigate this error immediately.',
    '',
    '## Error Details',
    `**Error:** ${issueTitle}`,
    culprit ? `**Location:** ${culprit}` : '',
    errorType ? `**Type:** ${errorType}` : '',
    errorValue ? `**Message:** ${errorValue}` : '',
    level ? `**Level:** ${level}` : '',
    platform ? `**Platform:** ${platform}` : '',
    shortId ? `**Short ID:** ${shortId}` : '',
    issueUrl ? `**Sentry Issue:** ${issueUrl}` : '',
    triggeredRule ? `**Triggered Rule:** ${triggeredRule}` : '',
    '',
    '## Occurrence Info',
    firstSeen ? `**First Seen:** ${firstSeen}` : '',
    lastSeen ? `**Last Seen:** ${lastSeen}` : '',
    count ? `**Event Count:** ${count}` : '',
    project ? `**Project:** ${project}` : '',
    release ? `**Release:** ${release}` : '',
    environment ? `**Environment:** ${environment}` : '',
    '',
    '## Tags',
    tagLines,
    extraLines ? `\n## Extra Context\n${extraLines}` : '',
    '',
    '## Investigation Steps',
    '1. Use your Sentry MCP integration to look up this issue. Examine the full stack trace, breadcrumbs, affected releases, and any related events.',
    '2. Use your Datadog MCP integration to check APM traces for the checkout-api service around the time of this error. Look at error rates, latency spikes, and correlated logs.',
    '3. Look at the source code in the COG-GTM/event-driven-devin repository to find the root cause. The error is in the checkout flow.',
    '4. Identify the exact line of code causing the issue and explain the root cause.',
    '5. Implement a fix in the code.',
    '6. Run the application locally (npm install && npm start) and test your fix to make sure it works before submitting anything.',
    '7. Once you have verified the fix works locally, create a PR with the fix.',
    '',
    '## Context',
    'Repository: https://github.com/COG-GTM/event-driven-devin',
    'Service: checkout-api',
    'Environment: demo',
    'Datadog Dashboard: https://app.us5.datadoghq.com/dashboard/y6q-9d9-7vg',
  ];

  return lines.filter((l) => l !== false && l !== null && l !== undefined).join('\n');
}

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
router.post('/webhooks/sentry', async (req, res) => {
  const payload = req.body;

  // Sentry sends a POST with action: "verification" when first setting up.
  // This must run before the API-key check so verification succeeds even
  // when DEVIN_API_KEY / DEVIN_ORG_ID are not yet configured.
  if (payload.action === 'verification') {
    logger.info('Sentry webhook verification request received');
    return res.json({ received: true, verification: true });
  }

  const apiKey = process.env.DEVIN_API_KEY;
  const orgId = process.env.DEVIN_ORG_ID;

  if (!apiKey || !orgId) {
    logger.error('Sentry webhook received but DEVIN_API_KEY or DEVIN_ORG_ID not configured');
    return res.status(500).json({ error: 'Devin API not configured' });
  }

  logger.info('Sentry webhook received', {
    action: payload.action,
    actor: payload.actor?.name || 'system',
    hookResource: req.headers['sentry-hook-resource'] || 'unknown',
  });

  try {
    const alertData = extractAlertData(payload);
    const prompt = buildPrompt(alertData);

    logger.info('Creating Devin session for Sentry alert', {
      issueTitle: alertData.issueTitle,
      issueUrl: alertData.issueUrl,
      errorType: alertData.errorType,
      errorValue: alertData.errorValue,
      level: alertData.level,
      project: alertData.project,
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
