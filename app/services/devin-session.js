const logger = require('../telemetry/logger');
const { postAlertToSlack, postDevinReply } = require('./slack');

/**
 * In-memory cooldown map to prevent duplicate alerts.
 * Key: normalized issue identifier, Value: timestamp of last alert.
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
 * This prompt is sent as a @Devin reply in the Slack thread so the
 * native Devin Slack integration picks it up and starts a session.
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
 * Post an alert to Slack and trigger Devin via native Slack integration.
 *
 * Flow:
 *   1. Post the rich alert message using the bot token (appears as "Automated Alerts")
 *   2. Reply in the thread using a user token with @Devin + investigation prompt
 *      — Slack treats user-token messages as coming from a real human
 *      — The Devin Slack app picks up the @mention and starts a session natively
 *
 * This replaces the previous API-based session creation + custom poller approach.
 * The native Devin Slack integration provides live thread updates, PR links,
 * and interactive conversation — much richer than our custom poller.
 *
 * @param {Object} alertData - Normalized alert data (issueTitle, errorType, etc.)
 * @returns {Object|null} - { triggered: true, threadTs } or null if skipped/failed
 */
async function createSessionAndAlert(alertData) {
  // Cooldown check
  const cooldownKey = `${alertData.issueTitle}`.toLowerCase().trim();
  const lastCreated = sessionCooldowns.get(cooldownKey);
  if (lastCreated && (Date.now() - lastCreated) < COOLDOWN_MS) {
    const remainingMin = Math.round((COOLDOWN_MS - (Date.now() - lastCreated)) / 60000);
    logger.info('Skipping duplicate — alert already sent recently', {
      issueTitle: alertData.issueTitle,
      cooldownRemainingMin: remainingMin,
    });
    return null;
  }

  // Mark cooldown immediately to prevent races
  sessionCooldowns.set(cooldownKey, Date.now());

  try {
    const prompt = buildPrompt(alertData);

    logger.info('Posting alert and triggering Devin via Slack', {
      issueTitle: alertData.issueTitle,
      errorType: alertData.errorType,
      errorValue: alertData.errorValue,
    });

    // Step 1: Post the rich alert message (bot token)
    const threadTs = await postAlertToSlack(alertData);

    if (!threadTs) {
      logger.warn('Alert post returned no thread timestamp — cannot trigger Devin reply');
      sessionCooldowns.delete(cooldownKey);
      return null;
    }

    // Step 2: Reply with @Devin + prompt using user token (triggers native Devin integration)
    await postDevinReply(threadTs, prompt);

    logger.info('Devin triggered via native Slack integration', {
      issueTitle: alertData.issueTitle,
      threadTs,
    });

    return { triggered: true, threadTs };
  } catch (error) {
    // Clear cooldown so the next attempt can retry
    sessionCooldowns.delete(cooldownKey);

    logger.error('Failed to post alert or trigger Devin', {
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
