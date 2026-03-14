const axios = require('axios');
const logger = require('../telemetry/logger');
const { postAlertToSlack, startSessionPoller } = require('./slack');

const DEVIN_API_BASE = 'https://api.devin.ai/v3';

/**
 * In-memory cooldown map to prevent duplicate Devin sessions.
 * Key: normalized issue identifier, Value: timestamp of last session created.
 * Cooldown: 5 minutes (matches alert rule frequency).
 */
const sessionCooldowns = new Map();
const COOLDOWN_MS = 5 * 60 * 1000;

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
 * Build a rich investigation prompt from alert data.
 * Includes every detail available so Devin has full context.
 */
function buildPrompt(alertData) {
  const {
    issueTitle, issueUrl, culprit, errorType, errorValue,
    tags, extra, level, platform, firstSeen, lastSeen,
    count, shortId, project, release, environment, triggeredRule,
  } = alertData;

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

  const tagRows = tags && tags.length > 0
    ? tags.map((t) => {
      const key = t.key || t[0] || '';
      const value = t.value || t[1] || '';
      return `| ${key} | ${value} |`;
    })
    : [];

  const tagTable = tagRows.length > 0
    ? ['| Tag | Value |', '|-----|-------|', ...tagRows].join('\n')
    : '_No tags available — use Sentry MCP to retrieve full tags._';

  const extraBlock = extra && Object.keys(extra).length > 0
    ? '```json\n' + JSON.stringify(extra, null, 2) + '\n```'
    : '';

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
 * Create a Devin session and post an alert to Slack.
 *
 * This is the shared core that both the Sentry webhook handler and the
 * storefront checkout error handler call. It handles:
 *   - Cooldown check (prevent duplicate sessions)
 *   - Devin API call to create session
 *   - Slack alert post with session link
 *   - Session poller for thread updates
 *
 * @param {Object} alertData - Normalized alert data (issueTitle, errorType, etc.)
 * @returns {Object|null} - { sessionId, url, status } or null if skipped/failed
 */
async function createSessionAndAlert(alertData) {
  const apiKey = process.env.DEVIN_API_KEY;
  const orgId = process.env.DEVIN_ORG_ID;

  if (!apiKey || !orgId) {
    logger.error('DEVIN_API_KEY or DEVIN_ORG_ID not configured — skipping session creation');
    return null;
  }

  // Cooldown check
  const cooldownKey = `${alertData.issueTitle}`.toLowerCase().trim();
  const lastCreated = sessionCooldowns.get(cooldownKey);
  if (lastCreated && (Date.now() - lastCreated) < COOLDOWN_MS) {
    const remainingMin = Math.round((COOLDOWN_MS - (Date.now() - lastCreated)) / 60000);
    logger.info('Skipping duplicate — session already created recently', {
      issueTitle: alertData.issueTitle,
      cooldownRemainingMin: remainingMin,
    });
    return null;
  }

  // Mark cooldown immediately to prevent races
  sessionCooldowns.set(cooldownKey, Date.now());

  try {
    const prompt = buildPrompt(alertData);

    logger.info('Creating Devin session', {
      issueTitle: alertData.issueTitle,
      errorType: alertData.errorType,
      errorValue: alertData.errorValue,
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

    return {
      sessionId: session.session_id,
      url: session.url,
      status: session.status,
    };
  } catch (error) {
    // Clear cooldown so the next attempt can retry
    sessionCooldowns.delete(cooldownKey);

    logger.error('Failed to create Devin session', {
      error: error.message,
      status: error.response?.status,
      data: error.response?.data,
    });

    return null;
  }
}

module.exports = {
  buildPrompt,
  createSessionAndAlert,
  sessionCooldowns,
  COOLDOWN_MS,
};
