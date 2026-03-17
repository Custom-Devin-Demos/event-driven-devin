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
    `> A Sentry alert just fired for the **${alertData.service || 'checkout-api'}** service.${triggeredRule ? ` Triggered by rule: **${triggeredRule}**.` : ''}`,
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
    '> **IMPORTANT:** You MUST complete a full investigation using both Sentry MCP and Datadog MCP BEFORE writing any code or attempting a fix. Do NOT skip ahead to remediation.',
    '',
    '### Phase 1: Sentry Deep-Dive (Required)',
    '',
    '1. **Look up this issue in Sentry** — Use your **Sentry MCP** integration to retrieve the full issue details. Do NOT rely solely on the alert data above.',
    '2. **Examine the full stack trace** — Identify every frame in the call stack. Note the exact file, function, and line number where the error originates.',
    '3. **Review breadcrumbs** — Walk through the breadcrumb trail to understand what happened leading up to the error (HTTP requests, console logs, navigation, user actions).',
    '4. **Check event history** — Look at how many times this error has occurred, when it first appeared, and whether the frequency is increasing. Note any patterns in affected releases or deployments.',
    '5. **Inspect tags and context** — Review all tags (browser, OS, user, transaction, release) and any extra context attached to the event to understand the conditions under which this error occurs.',
    '',
    '### Phase 2: Datadog Correlation (Required)',
    '',
    `6. **Query APM traces** — Use your **Datadog MCP** integration to search for APM traces for the \`${alertData.service || 'checkout-api'}\` service around the time window of this error. Filter by error status to find the relevant traces.`,
    `7. **Analyze error rates and trends** — Check the error rate for the \`${alertData.service || 'checkout-api'}\` service. Determine whether this is a sudden spike, a gradual increase, or a persistent baseline issue.`,
    '8. **Check latency and throughput** — Look for latency spikes or throughput changes that correlate with the error. This can reveal whether the issue is load-related or a pure code bug.',
    '9. **Review correlated logs** — Search Datadog logs for entries around the same timeframe. Look for upstream errors, dependency failures, or warnings that provide additional context.',
    '10. **Check the Datadog dashboard** — Review the [checkout-api dashboard](https://app.us5.datadoghq.com/dashboard/y6q-9d9-7vg) for an overall picture of service health, error distribution, and any anomalies.',
    '',
    '### Phase 3: Synthesize Findings',
    '',
    '11. **Summarize your investigation** — Before touching any code, write a clear summary in the Slack thread of what you found from Sentry and Datadog. Include: the root cause hypothesis, supporting evidence from both tools, the scope of impact, and your proposed fix.',
    '',
    '### Phase 4: Remediation (Only After Investigation)',
    '',
    '12. **Source Code** — Look at the source code in the [`COG-GTM/event-driven-devin`](https://github.com/COG-GTM/event-driven-devin) repository to confirm the root cause. Trace the error through the call stack — the root cause may be in a different function or file than where the error is thrown.',
    '13. **Implement the fix** — Write a targeted fix that addresses the confirmed root cause.',
    '14. **Test Locally in Browser** — Run the application locally with `npm install && npm start`. Open your browser to `http://localhost:3000`. Browse the storefront, add an item to your cart, and complete the full checkout flow. Verify the checkout succeeds without errors. Do NOT test via curl or API calls — use the browser UI to confirm the fix works end-to-end as a real user would.',
    '15. **Create PR** — Once you have verified the fix works in the browser, create a PR with the fix. Include your investigation findings from Sentry and Datadog in the PR description.',
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
    `> **Service:** ${alertData.service || 'checkout-api'}  `,
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
    const replyTs = await postDevinReply(threadTs, prompt);

    if (!replyTs) {
      logger.warn('Devin reply was not posted — trigger failed');
      sessionCooldowns.delete(cooldownKey);
      return null;
    }

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
