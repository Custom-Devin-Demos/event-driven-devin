const logger = require('../telemetry/logger');
const {
  postAlertToSlack,
  postBugReportToTriage,
  postDevinSessionLink,
  postIncidentLink,
} = require('./slack');
const { createDevinSession } = require('./devin-api');
const servicenow = require('./servicenow');
const { scheduleVulnerablePR } = require('./sonar-pr-trigger');
const { getCustomerConfig } = require('../../config/customers');
const { canCreateSession, reserveSession } = require('./session-rate-limiter');
const { legacyAlertsSuppressed } = require('./oncall-suppression');
const { currentAlertDestination } = require('./alert-destination');
const { buildTeamsAlertCard, buildTeamsFieldCard, postTeamsCard } = require('./teams');

let servicenowConfigWarningLogged = false;

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/**
 * Where this request's alert goes, from the presenter's hub choice
 * (alert_destination cookie). Teams needs AUTOMATIONS_TEAMS_WEBHOOK_URL; without
 * it the alert stays on Slack so the demo never goes silent.
 */
function resolveAlertRouting() {
  const destination = currentAlertDestination();
  if (destination === 'slack') return { slack: true, teamsUrl: null };
  const teamsUrl = process.env.AUTOMATIONS_TEAMS_WEBHOOK_URL;
  if (!teamsUrl) {
    logger.warn('Teams alert destination requested but AUTOMATIONS_TEAMS_WEBHOOK_URL is not set — posting to Slack');
    return { slack: true, teamsUrl: null };
  }
  return { slack: false, teamsUrl };
}

function buildTeamsAlertCardForAlert(alertData) {
  const owner = typeof alertData.devinEmail === 'string' && EMAIL_RE.test(alertData.devinEmail)
    ? alertData.devinEmail
    : null;
  const service = alertData.service || 'checkout-api';
  return buildTeamsFieldCard({
    title: `\u{1F6A8} Sentry Alert — ${alertData.verticalLabel || 'Checkout'} Error`,
    sections: [
      {
        fields: [
          ['Error', alertData.issueTitle],
          ['Severity', alertData.level || 'error'],
          ['Location', alertData.culprit, { mono: true }],
          ['Type', alertData.errorType],
        ],
      },
      { code: { label: 'Message', text: alertData.errorValue } },
      {
        fields: [
          ['Release', alertData.release || process.env.SENTRY_RELEASE || 'acme-checkout@1.0.2'],
          ['Environment', alertData.environment || process.env.DD_ENV || 'prod'],
          ['On-Call', 'Devin AI (auto-investigating)'],
          ['Triggered by', owner],
        ],
      },
    ],
    actions: [
      { title: 'View in Sentry', url: alertData.issueUrl },
      { title: 'View in Datadog', url: process.env.DD_DASHBOARD_URL || 'https://app.datadoghq.com' },
    ],
    // Teams hands responders only top-level TextBlocks, not ColumnSet contents,
    // so the facts the investigation needs are repeated in the footer.
    footer: [
      `Service: ${service}`,
      alertData.culprit ? `Location: ${alertData.culprit}` : null,
      alertData.errorType ? `Type: ${alertData.errorType}` : null,
      new Date().toISOString(),
    ].filter(Boolean).join(' | '),
  });
}

async function postAlertTeamsCard(teamsUrl, card, what) {
  try {
    await postTeamsCard(teamsUrl, card);
    logger.info(`${what} posted to Teams`);
    return true;
  } catch (error) {
    logger.error(`Failed to post ${what.toLowerCase()} to Teams`, {
      error: error.message,
      status: error.response?.status,
    });
    return false;
  }
}

function postTeamsFollowUp(teamsUrl, alertData, { title, facts, actionTitle, url }) {
  return postAlertTeamsCard(teamsUrl, buildTeamsAlertCard({
    title,
    color: 'Accent',
    facts: [['Alert', alertData.issueTitle], ...facts],
    actions: [{ title: actionTitle, url }],
  }), title.replace(/^\W+/, ''));
}

/**
 * Build the investigation prompt from alert data.
 * Uses the !sentry_investigation playbook macro so Devin follows
 * the standardized investigation & remediation workflow automatically.
 * Only the essential alert context is included — the playbook handles
 * the investigation steps, Sentry/Datadog queries, and fix process.
 */
function buildPrompt(alertData) {
  const {
    issueTitle, issueUrl, culprit, errorType, errorValue,
    tags, level, firstSeen, lastSeen,
    count, shortId, project, release, environment, triggeredRule,
  } = alertData;

  // Build a compact, scannable prompt.
  // Use null as skip sentinel so intentional blank-line separators ('') are preserved.
  const lines = [
    '!sentry_investigation',
    '',
    `*Error:* ${issueTitle}`,
    culprit ? `*Location:* \`${culprit}\`` : null,
    errorType ? `*Type:* ${errorType}` : null,
    errorValue ? `*Message:* ${errorValue}` : null,
    alertData.service ? `*Service:* ${alertData.service}` : null,
  ];

  // Compact metadata line — combine small fields with pipe separators
  const metaParts = [
    `Level: ${level || 'error'}`,
    project ? `Project: ${project}` : null,
    environment ? `Env: ${environment}` : null,
    release ? `Release: ${release}` : null,
  ].filter(Boolean);
  if (metaParts.length > 0) {
    lines.push('', metaParts.join(' | '));
  }

  // Event history line
  const historyParts = [
    count ? `Events: ${count}` : null,
    firstSeen ? `First: ${firstSeen}` : null,
    lastSeen ? `Last: ${lastSeen}` : null,
  ].filter(Boolean);
  if (historyParts.length > 0) {
    lines.push(historyParts.join(' | '));
  }

  // Extra identifiers
  if (shortId) lines.push(`Short ID: ${shortId}`);
  if (triggeredRule) lines.push(`Rule: ${triggeredRule}`);

  // Sentry link
  if (issueUrl) lines.push('', issueUrl);

  // Tags — inline comma-separated for compactness
  if (tags && tags.length > 0) {
    const tagPairs = tags
      .map((t) => {
        const key = t.key || t[0] || '';
        const value = t.value || t[1] || '';
        return key ? `${key}: ${value}` : null;
      })
      .filter(Boolean);
    if (tagPairs.length > 0) {
      lines.push('', `*Tags:* ${tagPairs.join(', ')}`);
    }
  }

  // Scenario-specific investigation directives. Callers must pass a service-owned
  // constant here — never request-derived data, which would reach the prompt verbatim.
  if (alertData.promptAppendix) {
    lines.push('', alertData.promptAppendix);
  }

  return lines
    .filter((l) => l !== null)
    .join('\n');
}

/**
 * Post an alert to Slack and trigger Devin investigation via the v3 API.
 *
 * Flow:
 *   1. Post the rich alert message to Slack using the bot token
 *   2. Create a Devin session via POST /v3/organizations/{org_id}/sessions
 *      — Uses create_as_user_id so the session appears in the selected user's account
 *   3. Post a "View in Devin" button in the Slack thread
 *
 * Per-customer config is resolved from alertData.customer (see config/customers.js).
 * If no customer is specified, the default global env vars are used.
 *
 * @param {Object} alertData - Normalized alert data (issueTitle, errorType, etc.)
 * @param {string} [alertData.customer] - Customer slug for per-customer config
 * @param {string} [alertData.devinUserId] - Devin user ID for per-user session creation
 * @param {string} [alertData.devinOrgId] - Devin org ID for per-org session creation
 * @returns {Object|null} - { triggered: true, threadTs } or null if skipped/failed
 */
async function createSessionAndAlert(alertData) {
  if (legacyAlertsSuppressed()) {
    logger.info('Legacy alert pipeline suppressed (on-call mode request)', {
      issueTitle: alertData.issueTitle,
    });
    return null;
  }
  try {
    let prompt = buildPrompt(alertData);

    // Resolve per-customer Devin configuration
    const config = getCustomerConfig(alertData.customer);

    // Attach config to alertData so downstream functions (e.g. buildAlertBlocks)
    // can use it without additional parameters
    alertData.customerConfig = config;

    // Resolve user/org IDs: prefer alertData overrides, fall back to customer config
    const resolvedUserId = alertData.devinUserId || config.devinUserId || '';
    const resolvedOrgId = alertData.devinOrgId || config.devinOrgId || '';

    logger.info('Posting alert and triggering Devin', {
      issueTitle: alertData.issueTitle,
      errorType: alertData.errorType,
      errorValue: alertData.errorValue,
      customer: config.customer,
      devinUserId: resolvedUserId || 'none',
      devinOrgId: resolvedOrgId || 'default',
    });

    const routing = resolveAlertRouting();

    // Mirror the bug report to the dedicated triage channel (#automated-devin-triage).
    // Report-only: this copy never triggers a Devin session. Fire-and-forget so it
    // can't block or break the primary alert + Devin flow.
    if (routing.slack) {
      postBugReportToTriage(alertData).catch((err) => {
        logger.warn('Triage bug report mirror failed', { error: err.message });
      });
    }

    // Step 1: Post the rich alert message (Slack bot token and/or Teams card)
    const teamsDelivery = routing.teamsUrl
      ? postAlertTeamsCard(routing.teamsUrl, buildTeamsAlertCardForAlert(alertData), 'Alert')
      : Promise.resolve(false);
    const threadTs = routing.slack ? await postAlertToSlack(alertData) : null;
    const teamsPosted = await teamsDelivery;
    const teamsUrl = teamsPosted ? routing.teamsUrl : null;

    if (!threadTs && !teamsPosted) {
      logger.warn('Alert was not delivered to Slack or Teams — cannot trigger Devin reply');
      return null;
    }

    // Append Slack thread context to the prompt so Devin can post investigation
    // findings back to the alert thread using curl + SLACK_BOT_TOKEN.
    const slackChannel = config.slackChannelId || process.env.SLACK_CHANNEL_ID || '';
    if (slackChannel && threadTs) {
      prompt += `\n\n*Slack Thread:* channel=${slackChannel} thread_ts=${threadTs}`;
    }

    if (config.itsm === 'servicenow' && servicenow.isConfigured()) {
      const incident = await servicenow.createIncident({
        shortDescription: alertData.title || alertData.issueTitle,
        description: prompt,
        assignmentGroup: config.itsmAssignmentGroup,
        correlationId: alertData.sentryIssueId || alertData.issueId || threadTs,
        cmdbCi: alertData.service,
      });

      if (incident) {
        if (threadTs) {
          await postIncidentLink(
            threadTs,
            incident,
            config.itsmAssignmentGroup,
            ...(config.slackChannelId ? [config.slackChannelId] : []),
          );
        }
        if (teamsUrl) {
          await postTeamsFollowUp(teamsUrl, alertData, {
            title: `\u{1F3AB} ServiceNow incident ${incident.number} created`,
            facts: [['Assignment group', config.itsmAssignmentGroup]],
            actionTitle: 'Open incident',
            url: incident.url,
          });
        }
        logger.info('ServiceNow incident created and linked', {
          issueTitle: alertData.issueTitle,
          incidentNumber: incident.number,
          customer: config.customer,
          threadTs,
        });
        scheduleVulnerablePR(0, config.customer, resolvedUserId, resolvedOrgId);
        return {
          triggered: true,
          throttled: false,
          threadTs,
          ...(teamsUrl ? { teams: true } : {}),
          session: null,
          incident,
        };
      }

      logger.warn('ServiceNow incident was not created — falling back to Devin session creation', {
        issueTitle: alertData.issueTitle,
        customer: config.customer,
      });
    }

    if (
      config.itsm === 'servicenow'
      && !servicenow.isConfigured()
      && !servicenowConfigWarningLogged
    ) {
      servicenowConfigWarningLogged = true;
      logger.warn('ServiceNow is not configured — falling back to Devin session creation', {
        customer: config.customer,
      });
    }

    // Teams-only alerts are picked up by the Devin Teams responder on the
    // channel, which investigates and replies in the alert's thread. Creating
    // a session here as well would start a second investigation.
    if (!threadTs && teamsUrl) {
      logger.info('Alert posted to Teams; leaving the investigation to the Teams responder', {
        issueTitle: alertData.issueTitle,
        customer: config.customer,
      });
      scheduleVulnerablePR(0, config.customer, resolvedUserId, resolvedOrgId);
      return {
        triggered: true, throttled: false, threadTs: null, teams: true, session: null,
      };
    }

    // Step 2: Check global session cap before creating a Devin session
    const capCheck = canCreateSession();
    let session = null;
    let throttled = false;

    if (!capCheck.allowed) {
      throttled = true;
      logger.warn('Devin session skipped — global cap reached', {
        issueTitle: alertData.issueTitle,
        customer: config.customer,
        current: capCheck.current,
        max: capCheck.max,
        retryAfterSeconds: capCheck.retryAfterSeconds,
      });
    } else {
      // Optimistically reserve a slot to prevent TOCTOU races during
      // the async createDevinSession() call.  Release on failure.
      const releaseSlot = reserveSession();

      // Create Devin session via v3 API
      session = await createDevinSession(prompt, {
        apiKey: config.apiKey,
        orgId: resolvedOrgId,
        userId: resolvedUserId,
        title: alertData.title,
        platform: alertData.sessionPlatform,
      });

      if (session) {
        if (threadTs) {
          await postDevinSessionLink(
            threadTs,
            session.url,
            ...(config.slackChannelId ? [config.slackChannelId] : []),
          );
        }
        logger.info('Devin session created and linked', {
          issueTitle: alertData.issueTitle,
          sessionId: session.sessionId,
          customer: config.customer,
          devinUserId: resolvedUserId || 'service-user',
          devinOrgId: resolvedOrgId || 'default',
          threadTs,
        });
      } else {
        // API failed — release the optimistic reservation so the slot
        // doesn't consume cap budget for a session that never existed.
        releaseSlot();
        logger.warn('Devin session was not created — API call failed or not configured', {
          customer: config.customer,
        });
      }
    }

    // Fire a vulnerable PR in the target repo immediately (only if not throttled).
    // This triggers SonarCloud -> quality gate failure -> Devin auto-remediation
    // in the background, demonstrating the full remediation pipeline.
    // Pass the same resolved user/org IDs so the CI session matches the Slack session.
    if (!throttled) {
      scheduleVulnerablePR(0, config.customer, resolvedUserId, resolvedOrgId);
    }

    return {
      triggered: !throttled,
      throttled,
      threadTs,
      session,
    };
  } catch (error) {
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
};
