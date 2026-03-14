const express = require('express');
const axios = require('axios');
const logger = require('../telemetry/logger');
const { postAlertToSlack, startSessionPoller } = require('../services/slack');

const router = express.Router();

const DEVIN_API_BASE = 'https://api.devin.ai/v3';

/**
 * In-memory cooldown map to prevent duplicate Devin sessions.
 * Key: Sentry issue title (normalized), Value: timestamp of last session created.
 * Sentry fires a webhook for every matching event, but we only want one
 * Devin session per incident. Default cooldown: 30 minutes.
 */
const sessionCooldowns = new Map();
const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

// Periodically evict expired cooldown entries to prevent unbounded Map growth
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of sessionCooldowns) {
    if (now - ts >= COOLDOWN_MS) {
      sessionCooldowns.delete(key);
    }
  }
}, COOLDOWN_MS);

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

  // Build the error details table rows (only include rows with values)
  const detailRows = [
    ['Error', issueTitle],
    ['Location', culprit],
    ['Type', errorType],
    ['Message', errorValue],
    ['Level', level],
    ['Platform', platform],
    ['Short ID', shortId],
    ['Sentry Issue', issueUrl ? `[${issueUrl}](${issueUrl})` : ''],
    ['Triggered Rule', triggeredRule],
  ].filter(([, v]) => v);

  const detailTable = [
    '| Field | Value |',
    '|-------|-------|',
    ...detailRows.map(([k, v]) => `| ${k} | ${v} |`),
  ].join('\n');

  // Build the occurrence info table rows
  const occurrenceRows = [
    ['First Seen', firstSeen],
    ['Last Seen', lastSeen],
    ['Event Count', count ? String(count) : ''],
    ['Project', project],
    ['Release', release],
    ['Environment', environment],
  ].filter(([, v]) => v);

  const occurrenceTable = occurrenceRows.length > 0
    ? [
      '| Field | Value |',
      '|-------|-------|',
      ...occurrenceRows.map(([k, v]) => `| ${k} | ${v} |`),
    ].join('\n')
    : '';

  // Build tags table
  const tagRows = tags && tags.length > 0
    ? tags.map((t) => {
      const key = t.key || t[0] || '';
      const value = t.value || t[1] || '';
      return `| ${key} | ${value} |`;
    })
    : [];

  const tagTable = tagRows.length > 0
    ? ['| Tag | Value |', '|-----|-------|', ...tagRows].join('\n')
    : '_No tags available in webhook payload — use Sentry MCP to retrieve full tags._';

  // Build extra context as code block
  const extraBlock = extra && Object.keys(extra).length > 0
    ? '```json\n' + JSON.stringify(extra, null, 2) + '\n```'
    : '';

  // Error message in a code block for readability
  const errorBlock = errorValue
    ? '```\n' + errorValue + '\n```'
    : '';

  const sections = [
    '# Sentry Alert — Investigate Immediately',
    '',
    `> A Sentry alert just fired for the **checkout-api** service.${triggeredRule ? ` Triggered by rule: **${triggeredRule}**.` : ''}`,
    '',
    '## Error Details',
    '',
    detailTable,
    '',
    errorBlock ? '### Error Message\n\n' + errorBlock : '',
    '',
    occurrenceTable ? '## Occurrence Info\n\n' + occurrenceTable : '',
    '',
    '## Tags',
    '',
    tagTable,
    '',
    extraBlock ? '## Extra Context\n\n' + extraBlock : '',
    '',
    '---',
    '',
    '## Investigation Steps',
    '',
    '1. **Sentry** — Use your Sentry MCP integration to look up this issue. Examine the full stack trace, breadcrumbs, affected releases, and any related events.',
    '2. **Datadog** — Use your Datadog MCP integration to check APM traces for the `checkout-api` service around the time of this error. Look at error rates, latency spikes, and correlated logs.',
    '3. **Source Code** — Look at the source code in the [`COG-GTM/event-driven-devin`](https://github.com/COG-GTM/event-driven-devin) repository to find the root cause. The error is in the checkout flow.',
    '4. **Root Cause** — Identify the exact line of code causing the issue and explain the root cause.',
    '5. **Fix** — Implement a fix in the code.',
    '6. **Test Locally in Browser** — Run the application locally with `npm install && npm start`. Open your browser to `http://localhost:3000`. Browse the storefront, add an item to your cart, and complete the full checkout flow. Verify the checkout succeeds without errors. Do NOT test via curl or API calls — use the browser UI to confirm the fix works end-to-end as a real user would.',
    '7. **Create PR** — Once you have verified the fix works in the browser, create a PR with the fix.',
    '',
    '---',
    '',
    '## Context',
    '',
    '| Resource | Link |',
    '|----------|------|',
    '| Repository | [COG-GTM/event-driven-devin](https://github.com/COG-GTM/event-driven-devin) |',
    '| Datadog Dashboard | [checkout-api overview](https://app.us5.datadoghq.com/dashboard/y6q-9d9-7vg) |',
    issueUrl ? `| Sentry Issue | [View in Sentry](${issueUrl}) |` : '',
    '',
    '> **Service:** checkout-api  ',
    '> **Environment:** prod',
  ];

  return sections
    .filter((l) => l !== false && l !== null && l !== undefined)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
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

    // Cooldown check: skip if we already created a session for this issue recently
    const cooldownKey = alertData.issueTitle.toLowerCase().trim();
    const lastCreated = sessionCooldowns.get(cooldownKey);
    if (lastCreated && (Date.now() - lastCreated) < COOLDOWN_MS) {
      const remainingMin = Math.round((COOLDOWN_MS - (Date.now() - lastCreated)) / 60000);
      logger.info('Skipping duplicate webhook — session already created recently', {
        issueTitle: alertData.issueTitle,
        cooldownRemainingMin: remainingMin,
      });
      return res.json({ received: true, skipped: true, reason: 'cooldown', cooldownRemainingMin: remainingMin });
    }

    // Mark cooldown immediately (before API call) to prevent races
    sessionCooldowns.set(cooldownKey, Date.now());

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

    // Post alert to Slack with Devin session link (non-blocking)
    const slackChannel = process.env.SLACK_CHANNEL_ID;
    postAlertToSlack(alertData, session.url)
      .then((threadTs) => {
        if (threadTs && session.session_id) {
          startSessionPoller(session.session_id, slackChannel, threadTs);
        }
      })
      .catch((err) => {
        logger.error('Slack post failed (non-blocking)', { error: err.message });
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
    // Clear cooldown so the next webhook can retry
    const failedKey = extractAlertData(payload).issueTitle.toLowerCase().trim();
    sessionCooldowns.delete(failedKey);

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
