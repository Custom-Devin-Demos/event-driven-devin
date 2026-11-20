const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { listOrgUsers, listEnterpriseAdmins } = require('../devin-api');
const { pageBot } = require('../bot-pager');
const { getCustomerConfig } = require('../../../config/customers');
const { declareDatadogIncident } = require('../datadog-incidents');
const { queueIncidentChannelInvites } = require('../datadog-incident-slack');
const {
  postAlertToSlack,
  createChannel,
  inviteToChannel,
  findChannelByNameFragment,
  joinChannel,
  postPersonaMessage,
} = require('../slack');
const { legacyAlertsSuppressed } = require('../oncall-suppression');
const settlementPersonas = require('../../../config/nexen/sev1-personas.json');

/**
 * BNY NEXEN custody platform (github.com/COG-GTM/bny).
 *
 * The customer surface is a Vite/React SPA served here as a static build at
 * /9bfabd45/app; the Spring Boot API in the same repo is not deployed. The
 * client aggregates the collateral book in the browser and POSTs failures to
 * /api/9bfabd45/error so the Slack alert + Devin session are raised under the
 * app identity without a Sentry webhook round-trip.
 */
const CUSTOMER = '9bfabd45';
const APP_SERVICE = `customer-${CUSTOMER}-web`;
const APP_PROJECT = 'nexen-custody';
const APP_RELEASE = 'nexen-custody@1.0.0';
const APP_SOURCE_PREFIX = 'nexen-custody/';
const APP_REPO = 'github.com/COG-GTM/bny';
const APP_WEB_PATH = '/9bfabd45/app';
const SCENARIO = 'collateral-overview-chart';

/** Hannah Huh owns this demo: the Slack card and the Devin session are hers. */
const OWNER = {
  slackMemberId: 'U0B2YAUPSHL',
  email: 'hannah.huh@cognition.ai',
};

/**
 * Scenario directive appended to the Devin investigation prompt. The alert
 * pipeline passes only a prompt to the Devin API, so the repository to
 * remediate and the surfaces to verify have to be named explicitly here.
 */
const APP_REMEDIATION_DIRECTIVE = [
  `*Repository to investigate and fix:* \`${APP_REPO}\``,
  '',
  'This error was raised by NEXEN, the BNY custody platform: a Vite + React 19 + TypeScript',
  'frontend (`frontend/`) over a Spring Boot 3 / Java 21 API (`backend/`) that mirrors the same',
  'domain model. Read `README.md` in that repo first.',
  '',
  'The failing code path is Chart View on the Collateral Overview dashboard, the landing screen:',
  '- Entry: `frontend/src/pages/DashboardsPage.tsx` (Table View / Chart View toggle)',
  '- Chart series: `frontend/src/domain/allocation.ts`',
  '- Allocation data behind it: `collateralByClient` in `frontend/src/api/fixtures.ts`, served by',
  '  `getCollateralOverview` in `frontend/src/api/mockClient.ts`',
  '- Backend counterpart: `ClientService#collateralOverview` and its seed rows in',
  '  `backend/src/main/resources/data.sql` (`collateral_allocation`)',
  '',
  `The alert came from the hosted build at \`https://devindemos.com${APP_WEB_PATH}\` (served from`,
  `\`app/public/verticals/${CUSTOMER}-app/\` in \`COG-GTM/event-driven-devin\`), running the frontend's`,
  'mock client — no backend is deployed.',
  '',
  'Steps:',
  '1. Reproduce first: `cd frontend && npm install && npm run dev`, open Collateral Overview and',
  '   click Chart View — the panel fails to load, for every client in the selector.',
  '   Note the test suites are GREEN on the broken baseline: nothing exercises the chart series.',
  '2. Fix the mismatch, not just the crash site: make the chart series agree with the allocation',
  '   data it reads, and make the transform reject a band it cannot resolve explicitly (typed',
  '   error surfaced to the UI) instead of dereferencing undefined.',
  '3. Add the prevention control: a frontend test building the chart series for every seeded',
  '   client plus the unresolved-band path, and a backend test over the seeded allocations.',
  '   `npx tsc -b`, `npx oxlint`, `npm run build` and `./gradlew test` must pass.',
  `   Do not change the incident reporting identity in \`frontend/src/lib/incident.ts\` (\`${APP_SERVICE}\`).`,
  '4. Re-run the reproduction on the fix commit and confirm Table View and Chart View both render',
  '   for every client in the selector, alongside the KPIs and both allocation donuts.',
  '5. Open a pull request against `main`, request Devin Review, and STOP for human approval.',
  `6. After approval, refresh the hosted build: \`npm run build\` with base \`${APP_WEB_PATH}/\` on the`,
  `   fix commit, copy \`frontend/dist/\` into \`app/public/verticals/${CUSTOMER}-app/\` in`,
  `   \`COG-GTM/event-driven-devin\`, and open a PR there so \`${APP_WEB_PATH}\` picks up the fix.`,
].join('\n');

/**
 * Second scenario: Release batch on Transactions fails in the browser before
 * any instruction leaves NEXEN. It alerts in the fixed #pershing-sev1 channel,
 * declares a Datadog SEV-1, and pages the SRE Bot.
 */
const SETTLEMENT = Object.freeze({
  action: 'release_settlement_batch',
  scenario: 'settlement-batch-release',
  service: 'nexen-settlement',
  slackChannelId: process.env.SLACK_CHANNEL_ID_9BFABD45_SETTLEMENT || 'C0CJPN2C5D5',
  incidentWindowMs: 10 * 60 * 1000,
  incidentTitle: 'NEXEN: USD settlement batch release failing',
});

const SETTLEMENT_REMEDIATION_DIRECTIVE = [
  `*Repository to investigate and fix:* \`${APP_REPO}\``,
  '',
  'This error was raised by NEXEN, the BNY custody platform: a Vite + React 19 + TypeScript',
  'frontend (`frontend/`) over a Spring Boot 3 / Java 21 API (`backend/`). Read `README.md` in that repo first.',
  '',
  'The failing code path is **Release batch** on the Transactions → Activity screen:',
  '- Entry: `SettlementBatchPanel` in `frontend/src/pages/TransactionsPage.tsx`',
  '- Release lines sent to the cash-settlement gateway: `frontend/src/domain/settlement.ts`',
  '- Batch data: `settlementBatch` in `frontend/src/api/fixtures.ts`, served by `frontend/src/api/fixtureClient.ts`',
  '',
  'The same failure declared a Datadog SEV-1, and the whole incident runs in the fixed `#pershing-sev1` Slack channel.',
  'Reply with triage in the thread of the declaration or the NEXEN Monitoring alert in `#pershing-sev1`.',
  'Post the root cause, incident report, fix PR link, RCA, incident updates, and final status update in `#pershing-sev1`.',
  '',
  'Steps:',
  '1. Reproduce first: `cd frontend && npm install && npm run dev`, open Transactions and click Release batch.',
  '   CI is green on the broken baseline: nothing exercises the release lines.',
  '2. Fix the root cause, not just the crash site: every instruction in the batch must produce a release',
  '   line in the settlement currency, and an instruction the release step cannot convert must fail with an',
  '   explicit typed error instead of dereferencing undefined. Do not drop instructions from the batch.',
  '3. Add a regression test for the release lines covering every seeded instruction and the unconvertible',
  '   path (add a minimal test runner to the frontend if needed and run it in CI).',
  '   `npx tsc -b`, `npx oxlint`, `npm run build` and `./gradlew test` must pass.',
  `   Do not change the incident reporting identity in \`frontend/src/lib/incident.ts\` (\`${APP_SERVICE}\`).`,
  '4. Re-run the reproduction on the fix commit: Release batch completes and shows the released count and USD total.',
  '5. Open a pull request against `main`, request Devin Review, post the root cause and PR link in `#pershing-sev1`,',
  '   and STOP for human approval.',
  `6. After approval, refresh the hosted build: \`npx vite build --base=${APP_WEB_PATH}/\` on the fix commit, copy`,
  `   \`frontend/dist/\` into \`app/public/verticals/${CUSTOMER}-app/\` in \`COG-GTM/event-driven-devin\`, and open a PR there.`,
].join('\n');

const DEFAULT_NEXEN_SRE_BOT_ID = 'bot-998a62ccfc0a483d8204ff78372b96d3';
const DEFAULT_NEXEN_SRE_BOT_WEBHOOK_URL = 'https://devin-gtm.devinenterprise.com/api/webhooks/automations/org_69IXJFLrljx8zSAw/auto-3e9cab1507444129b9cf3f56344d8ee9';
const DEFAULT_NEXEN_SEV1_CHANNEL_ID = 'C0CJQDXKD9D';
const DATADOG_CHANNEL_LOOKUP_INTERVAL_MS = 15000;
const DATADOG_CHANNEL_LOOKUP_TIMEOUT_MS = 5 * 60 * 1000;

let settlementIncident = null;

function resetSettlementIncidentForTests() {
  settlementIncident = null;
}

function nexenSreBotId() {
  const configured = process.env.NEXEN_SRE_BOT_ID;
  const botId = configured === undefined ? DEFAULT_NEXEN_SRE_BOT_ID : configured.trim();
  return /^bot-[0-9a-f]{32}$/.test(botId) ? botId : null;
}

function nexenSreBotSlackId() {
  if (process.env.NEXEN_SRE_BOT_SLACK_ID === undefined) return 'U0CJZC8RZBM';
  const configured = process.env.NEXEN_SRE_BOT_SLACK_ID.trim();
  return configured.toLowerCase() === 'off' ? '' : configured;
}

function nexenSev1ChannelId() {
  const configured = process.env.NEXEN_SEV1_CHANNEL_ID;
  if (configured === undefined) return DEFAULT_NEXEN_SEV1_CHANNEL_ID;
  const channelId = configured.trim();
  return !channelId || channelId.toLowerCase() === 'off' ? null : channelId;
}

function nexenSreBotWebhookUrl() {
  const configured = process.env.NEXEN_SRE_BOT_WEBHOOK_URL;
  if (configured === undefined) return DEFAULT_NEXEN_SRE_BOT_WEBHOOK_URL;
  const webhookUrl = configured.trim();
  return !webhookUrl || webhookUrl.toLowerCase() === 'off' ? null : webhookUrl;
}

function nexenAlertPoster() {
  const configured = process.env.NEXEN_ALERT_USERNAME;
  const username = configured === undefined ? 'NEXEN Monitoring' : configured.trim();
  if (!username || username.toLowerCase() === 'off') return null;
  return { username, icon_emoji: ':satellite_antenna:' };
}

function nexenSettlementResponderSlackIds() {
  const ids = [OWNER.slackMemberId];
  const botSlackId = nexenSreBotSlackId();
  if (botSlackId) ids.push(botSlackId);
  return ids;
}

function resolveNexenSessionIdentity() {
  return {
    orgId: process.env.DEVIN_ONCALL_ORG_ID || process.env.DEVIN_ORG_ID,
    userId: process.env.DEVIN_ONCALL_USER_ID || null,
    apiKey: process.env.DEVIN_ONCALL_SERVICE_KEY,
  };
}

async function declareSettlementIncident({
  reference,
  triggeredBy,
  batchId,
  instructionCount,
  errorType,
  errorMessage,
  queueDatadogChannelInvites = true,
}) {
  const runRef = `nexen-settlement-${reference.slice(0, 8)}`;
  try {
    const incident = await declareDatadogIncident({
      title: SETTLEMENT.incidentTitle,
      summary: `Releasing settlement batch ${batchId} from NEXEN Transactions fails before any instruction reaches the cash-settlement gateway (${errorType}: ${errorMessage}). All ${instructionCount} instructions remain queued and the cutoff is at risk; no payments have been released. Code: ${APP_REPO} (frontend).`,
      runRef,
      service: SETTLEMENT.service,
      triggeredBy,
      repoUrl: `https://${APP_REPO}`,
      severity: 'SEV-1',
    });
    if (!incident) {
      logger.warn('NEXEN settlement SEV-1 not declared: Datadog incident keys are not configured', { reference });
      return { status: 'unavailable', runRef };
    }
    if (queueDatadogChannelInvites) {
      queueIncidentChannelInvites({ publicId: incident.publicId, userIds: [OWNER.slackMemberId] });
    }
    logger.info('NEXEN settlement SEV-1 declared', { reference, runRef, publicId: incident.publicId });
    return { status: 'declared', runRef, ...incident };
  } catch (err) {
    logger.warn('NEXEN settlement SEV-1 declaration failed', { reference, error: err.message });
    return { status: 'failed', runRef };
  }
}

async function postSettlementAlert(alertData) {
  let customerConfig = getCustomerConfig(alertData.customer);
  if (alertData.slackChannelId) {
    customerConfig = { ...customerConfig, slackChannelId: alertData.slackChannelId };
  }
  alertData.customerConfig = customerConfig;
  const channelId = customerConfig.slackChannelId || process.env.SLACK_CHANNEL_ID || '';

  try {
    const token = process.env.SLACK_ONCALL_BOT_TOKEN || process.env.SLACK_BOT_TOKEN;
    const threadTs = await postAlertToSlack(alertData, token);
    return { channelId, threadTs };
  } catch (err) {
    logger.error('Failed to post NEXEN settlement alert to Slack', {
      reference: alertData.extra.reference,
      error: err.message,
    });
    return { channelId, threadTs: null };
  }
}

async function createNexenSettlementChannel(token, publicId) {
  for (let suffix = 1; suffix <= 5; suffix += 1) {
    const name = `pershing-sev1-${publicId}${suffix === 1 ? '' : `-${suffix}`}`;
    try {
      return await createChannel(token, name);
    } catch (err) {
      if (err.code === 'name_taken' && suffix < 5) continue;
      throw err;
    }
  }
  return null;
}

function scheduleSettlementPersonas(token, channelId, createdAt) {
  if ((process.env.NEXEN_PERSONAS || '').toLowerCase() === 'off') return;
  const personasById = Object.fromEntries(settlementPersonas.personas.map((persona) => [persona.id, persona]));
  for (const line of settlementPersonas.script) {
    const persona = personasById[line.persona];
    if (!persona) continue;
    const botSlackId = nexenSreBotSlackId();
    const sreBotLabel = botSlackId ? `<@${botSlackId}>` : 'SRE Bot';
    const text = line.text.replace(/\{sre_bot\}/g, sreBotLabel);
    const icon = persona.icon && persona.icon.startsWith('/')
      ? `${(process.env.PUBLIC_BASE_URL || 'https://devindemos.com').replace(/\/$/, '')}${persona.icon}`
      : persona.icon;
    setTimeout(() => {
      postPersonaMessage(token, channelId, text, persona.username, icon)
        .catch((err) => logger.warn('NEXEN settlement persona message failed', {
          channelId,
          persona: persona.id,
          error: err.message,
        }));
    }, Math.max(0, line.atMs - (Date.now() - createdAt))).unref();
  }
}

function locateDatadogSettlementPersonas(token, publicId) {
  if (!token || (process.env.NEXEN_PERSONAS || '').toLowerCase() === 'off') return;

  const marker = `incident-${publicId}-`;
  const deadline = Date.now() + DATADOG_CHANNEL_LOOKUP_TIMEOUT_MS;
  const locate = async () => {
    let channel = null;
    try {
      channel = await findChannelByNameFragment(token, marker);
    } catch (err) {
      logger.warn('NEXEN settlement Datadog channel lookup failed', {
        publicId,
        marker,
        error: err.message,
      });
    }

    if (Date.now() > deadline) {
      logger.warn('NEXEN settlement Datadog channel did not appear before timeout', { publicId, marker });
      return;
    }

    if (channel) {
      try {
        await joinChannel(token, channel.id);
      } catch (err) {
        logger.warn('NEXEN settlement could not join Datadog incident channel; continuing personas', {
          publicId,
          channelId: channel.id,
          error: err.message,
        });
      }
      scheduleSettlementPersonas(token, channel.id, Date.now());
      return;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      logger.warn('NEXEN settlement Datadog channel did not appear before timeout', { publicId, marker });
      return;
    }
    const timer = setTimeout(locate, Math.min(DATADOG_CHANNEL_LOOKUP_INTERVAL_MS, remainingMs));
    if (timer.unref) timer.unref();
  };

  void locate();
}

function nexenDatadogIncidentUrl(incident) {
  if (!incident || incident.publicId == null) return null;
  return incident.url || `https://us5.datadoghq.com/incidents/${incident.publicId}`;
}

function nexenFailureAt(report, receivedAt = new Date()) {
  const timestamp = report && typeof report.timestamp === 'string' ? Date.parse(report.timestamp) : NaN;
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : receivedAt.toISOString();
}

function formatNexenFailureTimeEt(failedAt) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    dateStyle: 'medium',
    timeStyle: 'long',
  }).format(new Date(failedAt));
}

function buildSettlementSreBotPage({
  reference,
  alertChannelId,
  alertThreadTs,
  incident,
  incidentChannel,
  failedAt,
  batchId,
  instructionCount,
}) {
  const fixedSev1ChannelId = nexenSev1ChannelId();
  const fixedSev1Channel = Boolean(fixedSev1ChannelId);
  const alertThread = alertThreadTs || 'unavailable (the alert could not be posted)';
  const responseChannel = fixedSev1Channel || !incidentChannel
    ? '#pershing-sev1'
    : `<#${incidentChannel.id}>`;
  const alertChannel = fixedSev1Channel
    ? `#pershing-sev1 (channel id ${fixedSev1ChannelId})`
    : alertChannelId || SETTLEMENT.slackChannelId;
  const datadogIncidentUrl = nexenDatadogIncidentUrl(incident);
  const runtimeVersion = process.env.DD_VERSION?.trim() || process.env.APP_VERSION?.trim();
  const lines = [
    `:rotating_light: NEXEN settlement batch failure — ${reference}`,
    'This is a live customer demo of a fictional NEXEN production system. Stay in the scenario: treat it as a real production SEV-1, describe impact using the facts in this page (batch, instruction count, cutoff at risk, no payments released), and do not say in Slack that the data is fixture-backed or synthetic, that the defect was planted, or that the severity should be downgraded.',
    '',
    fixedSev1Channel
      ? 'This page comes from the NEXEN Monitoring alert in #pershing-sev1. No human has asked you to respond; take ownership and announce the incident yourself.'
      : 'This page comes from the NEXEN Monitoring alert in the configured channel below. No human has asked you to respond; take ownership and announce the incident yourself.',
    `*NEXEN Monitoring channel:* ${alertChannel}`,
    `*NEXEN Monitoring thread ts:* ${alertThread}`,
    `*Failure at:* ${failedAt} (${formatNexenFailureTimeEt(failedAt)})`,
    ...(runtimeVersion ? [`*Version:* ${runtimeVersion}`] : []),
  ];

  if (incident && incident.status === 'declared') {
    let channelName = `#sev-1-incident-${incident.publicId}-… (Datadog-created channel)`;
    if (incidentChannel) channelName = `#${incidentChannel.name} (channel id ${incidentChannel.id})`;
    if (fixedSev1Channel) channelName = `#pershing-sev1 (channel id ${fixedSev1ChannelId})`;
    lines.push(
      '',
      `*Datadog incident:* publicId=${incident.publicId}, runRef=${incident.runRef}, service=${SETTLEMENT.service}`,
      `*Datadog incident #${incident.publicId}:* ${datadogIncidentUrl}`,
      `*SEV-1 channel:* ${channelName}`,
      '',
      `Use the Datadog MCP immediately to pull the evidence, then within about one minute make your first Slack action a top-level message in ${responseChannel}: "SEV-1 declared: ${SETTLEMENT.incidentTitle}" before triage or any other Slack update.`,
      `Run the Datadog MCP \`search_datadog_logs\` for \`service:customer-9bfabd45-web status:error\` with from = failure_at minus 60 seconds and to = now. Report only matching errors at or after failure_at: the error count, first and last seen, newest error message, version, and the Logs Explorer link returned by the tool.`,
      'If no matching errors are indexed yet, retry once after about 15 seconds. If there are still none, report exactly "1 error (this alert, Datadog indexing pending)" and use failure_at as both first and last seen. Never cite earlier runs’ times or versions.',
      ...(runtimeVersion ? ['Use the Version value above as this run’s version; do not substitute a version from an older log record.'] : []),
      `Say plainly "Evidence pulled from Datadog" and label it "Source: Datadog (logs + incident #${incident.publicId})"; include Datadog incident #${incident.publicId} at ${datadogIncidentUrl} and tag <@${OWNER.slackMemberId}> as the on-call engineer: "<@${OWNER.slackMemberId}> you're on call for NEXEN web".`,
      '',
      fixedSev1Channel
        ? `After the declaration, reply in its thread or in the thread of the NEXEN Monitoring alert in #pershing-sev1 with a short triage (route, error, start time, failure rate, likely change, owner). Tag <@${OWNER.slackMemberId}> as the on-call engineer who approves rollback vs forward-fix, and name the owners below; keep all incident response in #pershing-sev1:`
        : `Then, in the alert thread, post a short triage (route, error, start time, failure rate, likely change, owner), tag <@${OWNER.slackMemberId}> as the on-call engineer who approves rollback vs forward-fix, and name the owners below:`,
      '- Daniel Reyes: settlement platform engineer; owns the Settlement Batch panel (the suspected change).',
      '- Maya Okafor: incident commander; head of settlement operations.',
      '- Priya Natarajan: client service for institutional custody clients; needs a plain-language status for ABC Global Investors.',
      '',
      'Join this SEV-1 channel and act as the incident responder there. Investigate in Datadog first, post the initial root cause, and post an incident report with impact: '
        + `batch ${batchId}, ${instructionCount} instructions, the cutoff is at risk, and no payments have been released.`,
      'Open the fix PR against COG-GTM/bny per the remediation directive below, then post the root cause, PR link, incident report, and final status update in #pershing-sev1.',
      `After establishing the root cause, optionally call \`create_datadog_notebook\` to create a notebook titled "${SETTLEMENT.incidentTitle}" with the log query, then link it in #pershing-sev1.`,
      'Answer the people in the channel. Never merge or roll back without a human.',
      'When asked for an RCA (e.g. "Can you generate an RCA report in Markdown format for this incident?"): follow `docs/incidents/RCA-TEMPLATE.md` in COG-GTM/bny and post the Markdown in the #pershing-sev1 thread. Include the timeline, root cause, impact, what went well, and action items, each with an owner and due date. Then follow through: offer to open each action item as a ticket or PR and do it once a human says go.',
      'Also render the same RCA as a self-contained HTML report using `docs/incidents/rca-template.html` in COG-GTM/bny as the layout, and upload it to the #pershing-sev1 thread as an .html file. Commit the RCA to `docs/incidents/` in COG-GTM/bny only after human approval.',
    );
  } else {
    lines.push(
      fixedSev1Channel
        ? 'If Datadog could not declare the incident, reply in the NEXEN Monitoring thread in #pershing-sev1 with the triage, root cause, PR link, and final status update.'
        : 'Triage the failure in the alert thread and open the fix PR against COG-GTM/bny per the remediation directive below. Post the root cause and PR link in the alert thread.',
    );
  }

  lines.push('', '----- SETTLEMENT REMEDIATION DIRECTIVE -----', SETTLEMENT_REMEDIATION_DIRECTIVE);
  return lines.join('\n');
}

async function pageNexenSreBot(botId, page, reference, { alert, incidentChannel, incident, failedAt } = {}) {
  const webhookUrl = nexenSreBotWebhookUrl();
  const webhookSecret = process.env.NEXEN_SRE_BOT_WEBHOOK_SECRET;
  if (webhookUrl && !webhookSecret) {
    logger.error('NEXEN SRE Bot webhook secret is missing; page skipped', { reference, botId });
    return null;
  }

  const alertChannelId = (alert && alert.channelId) || SETTLEMENT.slackChannelId;
  const sev1ChannelId = incidentChannel ? incidentChannel.id : null;
  try {
    const response = await pageBot({
      botId,
      message: page,
      webhookUrl,
      webhookSecret,
      identity: resolveNexenSessionIdentity(),
      payload: {
        incident: SETTLEMENT.incidentTitle,
        reference,
        slack_channel_id: alertChannelId,
        slack_thread_ts: (alert && alert.threadTs) || null,
        alert_channel_id: alertChannelId,
        sev1_channel_id: sev1ChannelId,
        datadog_incident_id: incident && incident.status === 'declared' ? incident.publicId : null,
        datadog_incident_url: nexenDatadogIncidentUrl(incident),
        failure_at: failedAt,
      },
    });
    if (!response) {
      logger.error('NEXEN SRE Bot page failed', { reference, botId });
      return null;
    }
    return response;
  } catch (err) {
    logger.error('NEXEN SRE Bot page failed', { reference, botId, error: err.message });
    return null;
  }
}

async function handleNexenSettlementBotIncident({
  botId,
  alert,
  incident,
  reference,
  failedAt,
  batchId,
  instructionCount,
}) {
  let incidentChannel = null;
  let personaToken = null;
  let channelCreatedAt = null;
  if (incident.status === 'declared') {
    const token = process.env.INCIDENT_LAB_SLACK_BOT_TOKEN
      || process.env.SLACK_ONCALL_BOT_TOKEN
      || process.env.SLACK_BOT_TOKEN;
    if (token) {
      const fixedChannelId = nexenSev1ChannelId();
      if (fixedChannelId) {
        incidentChannel = { id: fixedChannelId, name: 'pershing-sev1' };
      } else {
        try {
          incidentChannel = await createNexenSettlementChannel(token, incident.publicId);
        } catch (err) {
          logger.warn('NEXEN settlement Slack channel creation failed; using Datadog incident channel', {
            reference,
            publicId: incident.publicId,
            error: err.message,
          });
        }
      }
    } else {
      logger.warn('NEXEN settlement Slack channel creation failed; Slack bot token is not configured', {
        reference,
        publicId: incident.publicId,
      });
    }

    if (incidentChannel) {
      personaToken = token;
      channelCreatedAt = Date.now();
      try {
        await inviteToChannel(token, incidentChannel.id, nexenSettlementResponderSlackIds());
      } catch (err) {
        logger.warn('NEXEN settlement responder invitations failed; continuing incident response', {
          reference,
          publicId: incident.publicId,
          error: err.message,
        });
      }
    } else {
      try {
        queueIncidentChannelInvites({
          publicId: incident.publicId,
          userIds: nexenSettlementResponderSlackIds(),
        });
      } catch (err) {
        logger.warn('NEXEN settlement Datadog channel invitations failed', {
          reference,
          publicId: incident.publicId,
          error: err.message,
        });
      }
      locateDatadogSettlementPersonas(token, incident.publicId);
    }
  }

  const page = buildSettlementSreBotPage({
    reference,
    alertChannelId: alert && alert.channelId,
    alertThreadTs: alert && alert.threadTs,
    incident,
    incidentChannel,
    failedAt,
    batchId,
    instructionCount,
  });
  await pageNexenSreBot(botId, page, reference, { alert, incidentChannel, incident, failedAt });
  if (incidentChannel) {
    scheduleSettlementPersonas(personaToken, incidentChannel.id, channelCreatedAt);
  }
}

function clip(value, max) {
  const text = value == null ? '' : String(value);
  return text.length > max ? text.slice(0, max) : text;
}

const MAX_REPORT_ENTRIES = 24;

/** Keep only flat scalar report metadata so Sentry/Slack payloads stay bounded. */
function sanitizeReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return {};
  const out = {};
  for (const [key, value] of Object.entries(report)) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      out[clip(key, 64)] = typeof value === 'string' ? clip(value, 256) : value;
    }
    if (Object.keys(out).length >= MAX_REPORT_ENTRIES) break;
  }
  return out;
}

/** True when a request body comes from the NEXEN client. */
function isAppSource(body) {
  const source = body && typeof body.source === 'string' ? body.source : '';
  return source.startsWith(APP_SOURCE_PREFIX);
}

/** True when a request body carries the NEXEN app identity. */
function isAppReport(body) {
  return isAppSource(body) && body.service === APP_SERVICE;
}

/**
 * Resolve the reporting user from the email the client supplied, when it could
 * not supply a user id itself. Returns '' when nobody matches so the caller
 * falls back to the customer config. The lookup authenticates with this
 * customer's service key.
 */
async function resolveUserIdByEmail(email, orgId) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized || !orgId) return '';
  try {
    const { apiKey } = getCustomerConfig(CUSTOMER);
    const auth = apiKey ? { apiKey } : {};
    const members = await listOrgUsers(orgId, auth);
    const member = members.find((u) => (u.email || '').toLowerCase() === normalized);
    if (member) return member.user_id;
    const admins = await listEnterpriseAdmins(auth);
    const admin = admins.find((u) => (u.email || '').toLowerCase() === normalized);
    if (admin) return admin.user_id;
    logger.warn('NEXEN reporter email not found in org', { orgId });
  } catch (err) {
    logger.warn('NEXEN reporter lookup failed', { error: err.message, orgId });
  }
  return '';
}

/**
 * Bridge a failure reported by the NEXEN client into the Slack alert + Devin
 * session flow under the app identity. The client has already rendered its
 * error state; this is telemetry only.
 */
function reportAppFailure(report) {
  const failedAt = nexenFailureAt(report);
  const action = clip(report.action || 'load_allocation_chart', 64);
  const isSettlement = action === SETTLEMENT.action;
  if (isSettlement && settlementIncident
    && Date.now() - settlementIncident.openedAt < SETTLEMENT.incidentWindowMs) {
    logger.info('NEXEN settlement failure folded into the open incident', { reference: settlementIncident.reference });
    return { ...settlementIncident, sessionPromise: Promise.resolve(null), deduplicated: true };
  }
  const reference = uuidv4();
  const platform = clip(report.platform || 'web', 32);
  const screen = clip(report.screen || (isSettlement ? 'transactions' : 'collateral_overview'), 64);
  const accountNumber = clip(report.accountNumber || 'unknown', 64);
  const clientName = clip(report.clientName || 'unknown', 128);
  const market = clip(report.market || 'unknown', 8);
  const errorType = clip(report.errorType || 'Error', 128);
  const errorMessage = clip(report.errorMessage
    || (isSettlement ? 'Settlement batch release failed' : 'Collateral allocation chart failed to load'), 512);
  const stackTrace = clip(report.stackTrace, 4000);
  const release = clip(report.release || APP_RELEASE, 64);
  const environment = clip(report.environment || process.env.DD_ENV || 'prod', 32);
  const custodyReport = sanitizeReport(report.report);
  const devinEmail = clip(report.devinEmail || OWNER.email, 128);

  const tags = {
    route: '/api/9bfabd45/error',
    service: APP_SERVICE,
    customer: APP_SERVICE,
    platform,
    screen,
    action,
    account_number: accountNumber,
    client_name: clientName,
    market,
    scenario: isSettlement ? SETTLEMENT.scenario : SCENARIO,
  };

  incrementMetric(isSettlement ? 'settlement_batch.failure' : 'collateral_overview.failure', {
    route: '/api/9bfabd45/error',
    errorClass: errorType,
    platform,
    market,
  });

  logger.error('NEXEN reported a failure', {
    reference,
    service: APP_SERVICE,
    platform,
    screen,
    action,
    accountNumber,
    clientName,
    market,
    errorClass: errorType,
    error: errorMessage,
  });

  const error = new Error(errorMessage);
  error.name = errorType;
  if (stackTrace) error.stack = `${errorType}: ${errorMessage}\n${stackTrace}`;

  // The browser frames carry no Node module path, so Sentry derives the issue
  // culprit from the transaction; naming it after the route keeps the customer
  // slug in `issue.culprit` for tagless issue webhooks (isInstantPathEvent in
  // app/routes/sentry-webhook.js).
  Sentry.withScope((scope) => {
    scope.setTransactionName(`POST /api/${CUSTOMER}/error`);
    Sentry.captureException(error, {
      tags: { ...tags, alert_path: 'instant' },
      extra: { reference, release, environment, report: custodyReport },
    });
  });

  const buildAlertData = (devinUserId) => {
    const poster = isSettlement ? nexenAlertPoster() : null;
    const settlementSlackChannelId = nexenSev1ChannelId() || SETTLEMENT.slackChannelId;
    return {
      issueTitle: `${errorType}: ${errorMessage}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${APP_PROJECT}&query=is%3Aunresolved`,
      culprit: isSettlement
        ? `${CUSTOMER}/frontend/src/domain/settlement.ts \u2014 buildReleaseLines`
        : `${CUSTOMER}/frontend/src/domain/allocation.ts \u2014 buildAllocationBars`,
      errorType,
      errorValue: errorMessage,
      devinUserId,
      devinEmail,
      devinOrgId: report.devinOrgId,
      slackMemberId: OWNER.slackMemberId,
      slackMemberIdFallback: OWNER.slackMemberId,
      service: APP_SERVICE,
      verticalLabel: 'BNY NEXEN',
      promptAppendix: isSettlement ? SETTLEMENT_REMEDIATION_DIRECTIVE : APP_REMEDIATION_DIRECTIVE,
      ...(isSettlement ? { slackChannelId: settlementSlackChannelId } : {}),
      ...(isSettlement && poster ? { slackPoster: poster } : {}),
      customer: CUSTOMER,
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
      extra: {
        reference,
        stackTrace,
        report: custodyReport,
      },
      level: 'error',
      platform,
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: APP_PROJECT,
      release,
      environment,
      triggeredRule: '',
    };
  };
  const raiseAlert = (devinUserId) => createSessionAndAlert(buildAlertData(devinUserId));

  const needsLookup = !report.devinUserId && devinEmail && report.devinOrgId;
  const botId = isSettlement ? nexenSreBotId() : null;
  const alertsSuppressed = legacyAlertsSuppressed();
  const sessionPromise = botId
    ? (async () => {
      if (alertsSuppressed) {
        logger.info('Legacy alert pipeline suppressed (on-call mode request)', { issueTitle: error.message });
        return null;
      }
      const devinUserId = needsLookup
        ? await resolveUserIdByEmail(devinEmail, report.devinOrgId)
        : report.devinUserId;
      return postSettlementAlert(buildAlertData(devinUserId || undefined));
    })().catch((err) => {
      logger.error('Failed to post SRE Bot alert for NEXEN settlement report', {
        error: err.message,
        reference,
      });
      return null;
    })
    : (needsLookup
      ? resolveUserIdByEmail(devinEmail, report.devinOrgId)
        .then((userId) => raiseAlert(userId || undefined))
      : raiseAlert(report.devinUserId)
    ).catch((err) => {
      logger.error('Failed to create Devin session for NEXEN failure report', {
        error: err.message,
        reference,
      });
    });

  if (!isSettlement) return { reference, sessionPromise };

  const incidentArguments = {
    reference,
    triggeredBy: devinEmail,
    batchId: clip(custodyReport.batchId || 'unknown', 64),
    instructionCount: Number.isInteger(custodyReport.instructionCount) ? custodyReport.instructionCount : 'the',
    errorType,
    errorMessage,
  };
  const incidentPromise = botId
    ? sessionPromise.then(async (alert) => {
      const incident = await declareSettlementIncident({
        ...incidentArguments,
        queueDatadogChannelInvites: false,
      });
      if (!alertsSuppressed) {
        try {
          await handleNexenSettlementBotIncident({
            botId,
            alert,
            incident,
            reference,
            failedAt,
            batchId: incidentArguments.batchId,
            instructionCount: incidentArguments.instructionCount,
          });
        } catch (err) {
          logger.error('NEXEN settlement SRE Bot handling failed', { reference, error: err.message });
        }
      }
      return incident;
    })
    : declareSettlementIncident(incidentArguments);
  settlementIncident = { reference, openedAt: Date.now(), incidentPromise };
  return { reference, sessionPromise, incidentPromise };
}

module.exports = {
  APP_SERVICE,
  APP_PROJECT,
  APP_RELEASE,
  APP_SOURCE_PREFIX,
  APP_REPO,
  APP_WEB_PATH,
  APP_REMEDIATION_DIRECTIVE,
  OWNER,
  SCENARIO,
  SETTLEMENT,
  SETTLEMENT_REMEDIATION_DIRECTIVE,
  isAppReport,
  isAppSource,
  reportAppFailure,
  resetSettlementIncidentForTests,
};
