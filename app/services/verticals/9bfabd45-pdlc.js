const logger = require('../../telemetry/logger');
const { pageBot } = require('../bot-pager');
const {
  findChannelByName,
  joinChannel,
  postPersonaMessage,
  postUserMessage,
  getThreadReplies,
} = require('../slack');
const script = require('../../../config/nexen/pdlc-personas.json');

/**
 * BNY demo 1 (PDLC) for the Pershing Access Android app
 * (COG-GTM/android-demos apps/b113a373).
 *
 * Three personas (one Slack app, chat:write.customize) discuss a feature idea in
 * #pershing-access-product. Nobody @mentions Devin: when the discussion ends
 * the iOS Engineer Bot is paged through the v3 messages API with the thread, so
 * it joins on its own, scopes the idea and posts wireframes. The runner then
 * watches the thread and, as the Bot answers, posts the persona change request
 * and the go-ahead, relaying each one to the Bot.
 *
 * A persona listed in BNY_PDLC_PERSONA_USER_TOKENS (JSON, persona id -> a real
 * Slack member's `xoxp-` user token) posts as that member instead. The Bot
 * watches the thread, so those lines reach it as Slack messages from a person
 * and show up that way in its Devin chat; the runner pages the line only if
 * the Bot has not answered within USER_POST_GRACE_MS.
 */
const DEFAULT_PDLC_BOT_ID = 'bot-59656379ddc5470281166b1458334c2c';
const DEFAULT_PDLC_BOT_SLACK_ID = 'U0CK6TNG7T3';
const DEFAULT_PDLC_BOT_APP_BOT_ID = 'B0CK8N59ZLL';
const DEFAULT_CHANNEL_NAME = 'bny-pershing-android-app';
const DEFAULT_CHANNEL_ID = 'C0CK3SP678E';
const DEFAULT_IOS_BOT_WEBHOOK_URL =
  'https://devin-gtm.devinenterprise.com/api/webhooks/automations/org_69IXJFLrljx8zSAw/auto-2203779474c643fb9262f44c8fd61791';
const APP_REPO = 'COG-GTM/android-demos';
const APP_MODULE = 'apps/b113a373';
const POLL_INTERVAL_MS = 10000;
const PAGE_ATTEMPTS = 4;
const PAGE_RETRY_MS = 20000;
const USER_POST_GRACE_MS = 90 * 1000;
const STAGE_TIMEOUT_MS = 30 * 60 * 1000;
const BUILD_TIMEOUT_MS = 90 * 60 * 1000;
const RUN_COOLDOWN_MS = 2 * 60 * 1000;
const PR_URL_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

let currentRun = null;

function pdlcBotId() {
  const configured = process.env.BNY_PDLC_BOT_ID;
  const botId = configured === undefined ? DEFAULT_PDLC_BOT_ID : configured.trim();
  return /^bot-[0-9a-f]{32}$/.test(botId) ? botId : null;
}

function pdlcBotSlackIds() {
  return {
    user: (process.env.BNY_PDLC_BOT_SLACK_ID || DEFAULT_PDLC_BOT_SLACK_ID).trim(),
    botId: (process.env.BNY_PDLC_BOT_APP_BOT_ID || DEFAULT_PDLC_BOT_APP_BOT_ID).trim(),
  };
}

function personaToken() {
  return process.env.BNY_PDLC_SLACK_BOT_TOKEN
    || process.env.SLACK_ONCALL_BOT_TOKEN
    || process.env.SLACK_BOT_TOKEN
    || '';
}

function personaUserTokens() {
  const raw = process.env.BNY_PDLC_PERSONA_USER_TOKENS;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return Object.fromEntries(Object.entries(parsed || {}).filter(([, token]) => typeof token === 'string' && token.trim()));
  } catch (err) {
    logger.warn('BNY_PDLC_PERSONA_USER_TOKENS is not valid JSON; personas post through the app', { error: err.message });
    return {};
  }
}

function sessionIdentity() {
  return {
    orgId: process.env.DEVIN_ONCALL_ORG_ID || process.env.DEVIN_ORG_ID,
    apiKey: process.env.DEVIN_ONCALL_SERVICE_KEY,
  };
}

const DEFAULT_ASSET_BASE_URL = 'https://devindemos.com';

function personaIcon(persona) {
  const icon = persona.icon || '';
  if (!icon.startsWith('/')) return icon;
  return `${(process.env.BNY_PDLC_ASSET_BASE_URL || DEFAULT_ASSET_BASE_URL).replace(/\/$/, '')}${icon}`;
}

const personasById = Object.fromEntries(script.personas.map((p) => [p.id, p]));

function isBotMessage(message, ids = pdlcBotSlackIds()) {
  if (!message) return false;
  return (ids.user && message.user === ids.user) || (ids.botId && message.bot_id === ids.botId);
}

function hasImages(message) {
  return Array.isArray(message.files) && message.files.some((f) => /^(image\/|text\/html)/.test(f.mimetype || '') || /\.(png|jpe?g|gif|webp|html?)$/i.test(f.name || ''));
}

function botRepliesAfter(messages, afterTs, ids) {
  return messages.filter((m) => isBotMessage(m, ids) && Number(m.ts) > Number(afterTs));
}

function threadPermalink(channelId, threadTs) {
  return `https://coggtm.slack.com/archives/${channelId}/p${String(threadTs).replace('.', '')}`;
}

function slackLine(persona, text) {
  return `${persona.username}: ${text}`;
}

function jiraConfig() {
  return {
    ...script.jira,
    projectKey: process.env.BNY_PDLC_JIRA_PROJECT || script.jira.projectKey,
  };
}

/**
 * The Bot's standing instructions for this channel. The Bot keeps them in its
 * own memory, so each page carries only the Slack lines and reads like Slack in
 * the Bot's chat. docs/BNY-PDLC-BOT-INSTRUCTIONS.md is this text.
 */
function buildBotInstructions() {
  const owner = script.engineeringOwner;
  const jira = jiraConfig();
  const ownerTag = `<@${owner.slackId}>`;
  return [
    `# Standing instructions: #${DEFAULT_CHANNEL_NAME} (Pershing Access Android)`,
    '',
    `Pages from your \`webhook:incoming\` automation carry new lines from a thread in #${DEFAULT_CHANNEL_NAME} (Slack team T08RSEMT71Q). The payload's \`channel_id\` and \`thread_ts\` name the thread; \`message\` is the Slack text, one \`Name: text\` line per message. Treat them as Slack messages in that thread and reply there with your Slack tool. Nobody @mentions you: you join product threads on your own as the team's AI product engineer.`,
    'Stay in the scenario: talk like a teammate and never mention pages, webhooks, relays, scripts or a demo in Slack.',
    'Teammates may also reply in that thread as themselves in Slack. As soon as a page names a thread, watch it (Slack tool `watch_thread` with its `channel_id` and `thread_ts`) so their replies reach you directly. A line that arrives both ways is one line: answer it once.',
    '',
    `*App:* Pershing Access Android, \`${APP_REPO}\` module \`${APP_MODULE}\` (Kotlin + Jetpack Compose; Holdings screen and rows in \`core/Holdings.kt\` and the Holdings UI; rows expand one at a time).`,
    `*Engineering owner:* ${owner.name} (Slack ${ownerTag}, ${owner.email}) owns the app.`,
    `*Team:* ${script.personas.map((p) => `${p.username} (${p.role.split('.')[0]})`).join('; ')}.`,
    '',
    '## When a new product discussion asks for wireframes (first page for a thread)',
    `1. File a Jira ticket with your Atlassian tools: site ${jira.site}, project ${jira.projectKey}, issue type "${jira.issueType}", summary "Pershing Access Android: <feature> (v1)", assignee ${owner.name} (look up ${owner.email}), description = the v1 scope, the KPI, acceptance criteria and a link to the thread.`,
    `2. One short message: how you'd scope v1 (3-5 bullets: entry point, threshold model, on-device storage, what is out of scope), one KPI to watch, the Jira ticket as a link on its key, and one line tagging ${ownerTag} as the app's engineering owner (e.g. "${ownerTag} looping you in as engineering owner for Pershing Access Android; ticket is assigned to you").`,
    '3. Then 2-3 wireframe options of the screen as PNG images, each drawn inside a phone frame (labelled A/B/C), attached to one post with one line per option, plus one polished, self-contained HTML artifact (the scope, the KPI and the options side by side in phone frames, in the app\'s colors and type). Aim to have them up within a few minutes.',
    '4. Stop and wait for the next page.',
    '',
    '## Each later line (a page or a Slack reply in the thread)',
    'Answer each new line once, in the thread.',
    '- A change request: post the revised wireframes (PNG, in a phone frame) plus an updated HTML artifact, ask if that\'s good to build, and update the Jira ticket\'s acceptance criteria.',
    `- A go-ahead: say you're on it (move the Jira ticket to In Progress), then dispatch a child session bound to the thread (bot_slack_channel = channel_id, bot_slack_thread_ts = thread_ts) that implements the agreed design in ${APP_REPO} ${APP_MODULE} on a new branch named after the Jira key with JVM tests, runs \`make build test lint APP=b113a373\` on Java 17, records a short emulator video of the new flow composited inside an Android phone frame as the preview MP4, opens a PR (never merges) whose title starts with the Jira key and whose description links the ticket, comments the PR link on the Jira ticket, and posts in the thread the PR link, the Jira ticket link, one line tagging ${ownerTag} as engineering owner for review, the phone-framed preview video and a polished self-contained HTML artifact (\`price-alerts-preview.html\`: what shipped, the Jira ticket, phone-framed screens of each state, tests run).`,
    '',
  ].join('\n');
}

function buildJoinPage({ channelId, threadTs }) {
  return [
    `#${DEFAULT_CHANNEL_NAME} · ${threadPermalink(channelId, threadTs)}`,
    ...script.discussion.map((line) => slackLine(personasById[line.persona], line.text)),
  ].join('\n');
}

function buildRelayPage({ persona, text }) {
  return `#${DEFAULT_CHANNEL_NAME} · ${slackLine(persona, text)}`;
}

function defaultDeps() {
  return {
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref(); }),
    now: () => Date.now(),
    findChannelByName,
    joinChannel,
    postPersonaMessage,
    postUserMessage,
    getThreadReplies,
    pageBot,
  };
}

async function resolveChannel(token, deps) {
  if (process.env.BNY_PDLC_CHANNEL_ID) return process.env.BNY_PDLC_CHANNEL_ID;
  const name = process.env.BNY_PDLC_CHANNEL_NAME;
  if (!name) return DEFAULT_CHANNEL_ID;
  const channel = await deps.findChannelByName(token, name);
  if (!channel) throw new Error(`Slack channel #${name} not found`);
  return channel.id;
}

async function postAs(run, deps, personaId, text) {
  const persona = personasById[personaId];
  const userToken = run.userTokens[personaId];
  const ts = userToken
    ? await deps.postUserMessage(userToken, run.channelId, text, run.threadTs || undefined)
    : await deps.postPersonaMessage(run.token, run.channelId, text, persona.username, personaIcon(persona), run.threadTs || undefined);
  run.log.push({ at: new Date(deps.now()).toISOString(), persona: personaId, ts, asUser: Boolean(userToken) });
  return { persona, ts, asUser: Boolean(userToken) };
}

async function page(run, deps, message, label) {
  const webhookSecret = process.env.BNY_IOS_BOT_WEBHOOK_SECRET || '';
  const webhookUrl = webhookSecret ? (process.env.BNY_IOS_BOT_WEBHOOK_URL || DEFAULT_IOS_BOT_WEBHOOK_URL) : '';
  if (!run.botId && !webhookUrl) {
    logger.warn('BNY PDLC Bot page skipped: no BNY_IOS_BOT_WEBHOOK_SECRET and BNY_PDLC_BOT_ID is not a bot id', { runId: run.id, label });
    return null;
  }
  let response = null;
  for (let attempt = 1; attempt <= PAGE_ATTEMPTS && !response; attempt += 1) {
    if (attempt > 1) {
      logger.warn('BNY PDLC Bot page retrying', { runId: run.id, label, attempt });
      await deps.sleep(PAGE_RETRY_MS);
    }
    response = await deps.pageBot({
      botId: run.botId,
      message,
      webhookUrl,
      webhookSecret,
      identity: sessionIdentity(),
      context: { channel_id: run.channelId, thread_ts: run.threadTs, event: label },
    });
  }
  if (!response) {
    run.pageFailures.push(label);
    logger.error('BNY PDLC Bot page failed', { runId: run.id, label, botId: run.botId });
  }
  return response;
}

async function waitForBot(run, deps, { afterTs, timeoutMs, match }) {
  const deadline = deps.now() + timeoutMs;
  while (deps.now() < deadline && !run.cancelled) {
    await deps.sleep(POLL_INTERVAL_MS);
    let messages;
    try {
      messages = await deps.getThreadReplies(run.token, run.channelId, run.threadTs);
    } catch (err) {
      logger.warn('BNY PDLC thread poll failed', { runId: run.id, error: err.message });
      continue;
    }
    const hit = botRepliesAfter(messages, afterTs).find(match);
    if (hit) return hit;
  }
  return null;
}

async function replyAndRelay(run, deps, step, afterBot) {
  await deps.sleep(step.afterBotMs || 0);
  const { persona, ts, asUser } = await postAs(run, deps, step.persona, step.text);
  if (asUser) {
    const answered = await waitForBot(run, deps, { afterTs: ts, timeoutMs: USER_POST_GRACE_MS, match: () => true });
    if (answered) return { ts, afterBot };
    run.userPostFallbacks.push(step.persona);
    logger.warn('BNY PDLC Bot did not answer a Slack post from a person; paging the line', { runId: run.id, persona: step.persona });
  }
  await page(run, deps, buildRelayPage({
    channelId: run.channelId, threadTs: run.threadTs, persona, text: step.text, ts,
  }), step.persona);
  return { ts, afterBot };
}

async function executeRun(run, deps) {
  run.channelId = await resolveChannel(run.token, deps);
  try {
    await deps.joinChannel(run.token, run.channelId);
  } catch (err) {
    logger.warn('BNY PDLC could not join the product channel; posting anyway', { runId: run.id, error: err.message });
  }

  run.stage = 'discussion';
  let elapsed = 0;
  for (const line of script.discussion) {
    if (line.atMs > elapsed) await deps.sleep(line.atMs - elapsed);
    elapsed = Math.max(elapsed, line.atMs);
    const { ts } = await postAs(run, deps, line.persona, line.text);
    if (!run.threadTs) run.threadTs = ts;
  }
  const lastDiscussionTs = run.log[run.log.length - 1].ts;

  run.stage = 'awaiting_wireframes';
  await page(run, deps, buildJoinPage({ channelId: run.channelId, threadTs: run.threadTs }), 'join');
  const wireframes = await waitForBot(run, deps, { afterTs: lastDiscussionTs, timeoutMs: STAGE_TIMEOUT_MS, match: hasImages });
  if (!wireframes) return 'timeout_wireframes';

  run.stage = 'awaiting_revision';
  const change = await replyAndRelay(run, deps, script.changeRequest, wireframes);
  const revision = await waitForBot(run, deps, { afterTs: change.ts, timeoutMs: STAGE_TIMEOUT_MS, match: hasImages });
  if (!revision) return 'timeout_revision';

  run.stage = 'awaiting_pr';
  const go = await replyAndRelay(run, deps, script.goAhead, revision);
  const pr = await waitForBot(run, deps, { afterTs: go.ts, timeoutMs: BUILD_TIMEOUT_MS, match: (m) => PR_URL_RE.test(m.text || '') });
  if (!pr) return 'timeout_pr';
  run.prUrl = (pr.text.match(PR_URL_RE) || [])[0];

  if (script.wrapUp) {
    await deps.sleep(script.wrapUp.afterBotMs || 0);
    await postAs(run, deps, script.wrapUp.persona, script.wrapUp.text);
  }
  return 'complete';
}

function publicState(run) {
  if (!run) return { status: 'idle' };
  return {
    id: run.id,
    status: run.status,
    stage: run.stage,
    channelId: run.channelId,
    threadTs: run.threadTs,
    threadUrl: run.channelId && run.threadTs ? threadPermalink(run.channelId, run.threadTs) : null,
    prUrl: run.prUrl || null,
    pageFailures: run.pageFailures,
    userPostFallbacks: run.userPostFallbacks,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt || null,
    error: run.error || null,
  };
}

/**
 * Start one PDLC run. Only one run at a time, and a short cooldown after a run
 * ends so a double click does not post the discussion twice.
 */
function startPdlcRun({ triggeredBy = 'unknown' } = {}, deps = defaultDeps()) {
  const token = personaToken();
  if (!token) return { started: false, reason: 'slack_not_configured', state: publicState(currentRun) };
  if (currentRun && currentRun.status === 'running') {
    return { started: false, reason: 'already_running', state: publicState(currentRun) };
  }
  if (currentRun && currentRun.finishedAtMs && deps.now() - currentRun.finishedAtMs < RUN_COOLDOWN_MS) {
    return { started: false, reason: 'cooldown', state: publicState(currentRun) };
  }

  const run = {
    id: `pdlc-${deps.now().toString(36)}`,
    status: 'running',
    stage: 'starting',
    token,
    botId: pdlcBotId(),
    channelId: null,
    threadTs: null,
    userTokens: personaUserTokens(),
    log: [],
    pageFailures: [],
    userPostFallbacks: [],
    startedAt: new Date(deps.now()).toISOString(),
  };
  currentRun = run;
  logger.info('BNY PDLC run started', { runId: run.id, triggeredBy });

  run.done = executeRun(run, deps)
    .then((outcome) => {
      run.status = outcome === 'complete' ? 'complete' : 'stopped';
      run.stage = outcome;
    })
    .catch((err) => {
      run.status = 'failed';
      run.error = err.message;
      logger.error('BNY PDLC run failed', { runId: run.id, stage: run.stage, error: err.message });
    })
    .finally(() => {
      run.finishedAtMs = deps.now();
      run.finishedAt = new Date(run.finishedAtMs).toISOString();
      logger.info('BNY PDLC run finished', { runId: run.id, status: run.status, stage: run.stage });
    });

  return { started: true, state: publicState(run), run };
}

function stopPdlcRun() {
  if (currentRun && currentRun.status === 'running') currentRun.cancelled = true;
  return publicState(currentRun);
}

function getPdlcState() {
  return publicState(currentRun);
}

function resetPdlcForTests() {
  currentRun = null;
}

module.exports = {
  startPdlcRun,
  stopPdlcRun,
  getPdlcState,
  buildBotInstructions,
  buildJoinPage,
  buildRelayPage,
  isBotMessage,
  hasImages,
  resetPdlcForTests,
  PR_URL_RE,
};
