const crypto = require('crypto');
const axios = require('axios');
const logger = require('../telemetry/logger');
const {
  findChannelByNameFragment,
  getChannelHistory,
  inviteToChannel,
  joinChannel,
  postMessage,
  postPersonaMessage,
} = require('./slack');
const { declareDatadogIncident, resolveDatadogIncident } = require('./datadog-incidents');

const DEFAULT_RUN_WINDOW_MS = 60 * 60 * 1000;
const MIN_SAFE_TO_DECLARE_MS = 30 * 60 * 1000;
const SMOKE_POLL_WINDOW_MS = 20 * 60 * 1000;
const DEFAULT_TIME_ZONE = 'America/Los_Angeles';
const STANDING_REPO = 'ananthv26-cog-demo-repos/automations-service';
const CHANNEL_LOOKUP_INTERVAL_MS = 15000;
const CHANNEL_LOOKUP_MAX_ATTEMPTS = 40;
const IC = { username: 'Maya Chen (IC)', icon: ':female-technologist:' };
const ENG = { username: 'Ethan Brooks (ENG)', icon: ':male-technologist:' };
const INFRA = { username: 'Priya Shah (INFRA)', icon: ':female-technologist:' };
const BIZ = { username: 'Jordan Ellis (BIZ)', icon: ':briefcase:' };
const LEAD = { username: 'Sam Ortiz (ENG LEAD)', icon: ':necktie:' };
const CHATTER = [
  { afterMs: 30 * 1000, ...IC, text: 'sorry to the platform team you all got added, we don\'t have a team on automations' },
  { afterMs: 60 * 1000, ...INFRA, text: 'hey, do you need infra help here?' },
  { afterMs: 90 * 1000, ...IC, text: 'no / well — for a class-of-issues fix later yes, but for now no' },
  { afterMs: 2 * 60 * 1000, ...ENG, text: 'did we ship anything yesterday? I don\'t see a deploy' },
  { afterMs: 3 * 60 * 1000, ...IC, text: 'looks like one customer has been poisoning our automations queue somehow — the queued event carries an indirect-data blob and the name we picked for it doesn\'t work on every storage provider' },
  { afterMs: 4 * 60 * 1000, ...IC, text: 'and there\'s some bad logic where if one org\'s upload fails, the whole batch fails' },
  { afterMs: 5 * 60 * 1000, ...INFRA, text: 'is the queue itself down? AWS status is green' },
  { afterMs: 6 * 60 * 1000, ...BIZ, text: 'customers are asking — blast radius? is this a sev2?' },
  { afterMs: 7 * 60 * 1000, ...LEAD, text: 'what\'s actually broken for customers right now — all scheduled automations, or just that one org?' },
  { afterMs: 8 * 60 * 1000, ...IC, text: '{devin} can you confirm the root cause, and start a task to put up a fix so one org\'s failed storage upload doesn\'t fail the whole tick — mark that org\'s events failed immediately instead (unless that hurts ingest perf, lmk)' },
  { afterMs: 10 * 60 * 1000, ...ENG, text: 'what\'s the fastest way to disable that customer\'s automation? request prod db access or impersonate their org admin?' },
  { afterMs: 11 * 60 * 1000, ...IC, text: 'I think we can turn off automations ingest with the feature flag and stop the bleeding, then cherry-pick a fix and turn it back on' },
  { afterMs: 13 * 60 * 1000, ...ENG, text: 'wait — non-scheduled automations go through the same queue right? so everything from that org is broken anyway?' },
  { afterMs: 14 * 60 * 1000, ...IC, text: 'yes, all of that org\'s automations are broken — but other orgs only get hit when a schedule tick batches them together' },
  { afterMs: 16 * 60 * 1000, ...BIZ, text: 'do we need a status page update? I can start drafting the customer-facing statement' },
  { afterMs: 18 * 60 * 1000, ...ENG, text: 'disabled the customer\'s automation — should mitigate this now :crossed_fingers:' },
];

function renderChatterText(text) {
  const devinId = process.env.DEVIN_SLACK_USER_ID;
  return text.replace('{devin}', devinId ? `<@${devinId}>` : 'Devin');
}

const state = {
  runState: 'idle',
  armedAt: null,
  declaredAt: null,
  channel: null,
  incident: null,
  chatterPosted: 0,
  autoStopAt: null,
  scheduledDeclareAt: null,
  scheduledArmAt: null,
  timers: new Set(),
  declarePromise: null,
  stopPromise: null,
  smokeInProgress: false,
};

function envNumber(name, fallback) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function tokenMatches(presentedToken, configuredToken) {
  if (typeof presentedToken !== 'string') return false;
  const presented = crypto.createHash('sha256').update(presentedToken).digest();
  const configured = crypto.createHash('sha256').update(configuredToken).digest();
  return crypto.timingSafeEqual(presented, configured);
}

function standingConfig() {
  const baseUrl = (process.env.AUTOMATIONS_DEMO_SERVICE_BASE_URL || '').replace(/\/+$/, '');
  const token = process.env.AUTOMATIONS_DEMO_SERVICE_TOKEN;
  if (!baseUrl || !token) {
    throw new Error(
      'standing instance unreachable: configure AUTOMATIONS_DEMO_SERVICE_BASE_URL and AUTOMATIONS_DEMO_SERVICE_TOKEN',
    );
  }
  return { baseUrl, token };
}

async function standingRequest(method, path, body) {
  const { baseUrl, token } = standingConfig();
  try {
    const response = await axios({
      method,
      url: `${baseUrl}${path}`,
      data: body,
      headers: { Authorization: `Bearer ${token}` },
      timeout: 8000,
    });
    return response.data;
  } catch (error) {
    const detail = error.response?.data?.error || error.response?.data?.message
      || error.code || error.message;
    throw new Error(`standing instance unreachable: ${detail}`, { cause: error });
  }
}

async function armStanding(customer = 'CUST_1') {
  return standingRequest('post', '/admin/demo/arm', { customer });
}

async function arm(customer = 'CUST_1', options = {}) {
  if (!options.smoke && state.smokeInProgress) {
    const error = new Error('Cannot arm while a smoke run is in progress');
    error.statusCode = 400;
    throw error;
  }
  if (state.runState === 'declared' || state.declarePromise || state.stopPromise) {
    const error = new Error('Cannot arm while an incident run is active or stopping');
    error.statusCode = 400;
    throw error;
  }
  const result = await armStanding(customer);
  const hasFutureSchedule = state.scheduledDeclareAt
    && Date.parse(state.scheduledDeclareAt) > Date.now();
  state.channel = null;
  state.incident = null;
  state.declaredAt = null;
  state.chatterPosted = 0;
  state.autoStopAt = null;
  if (!hasFutureSchedule) {
    state.scheduledDeclareAt = null;
    state.scheduledArmAt = null;
  }
  state.armedAt = result.armed_at || new Date().toISOString();
  state.runState = 'armed';
  return result;
}

async function disarmStanding() {
  return standingRequest('post', '/admin/demo/disarm');
}

async function statusStanding() {
  return standingRequest('get', '/admin/demo/status');
}

function scheduleTimer(callback, delay) {
  const timer = setTimeout(() => {
    state.timers.delete(timer);
    callback();
  }, Math.max(0, delay));
  if (timer.unref) timer.unref();
  state.timers.add(timer);
  return timer;
}

function cancelTimers() {
  for (const timer of state.timers) {
    clearTimeout(timer);
    state.timers.delete(timer);
  }
}

function slackToken() {
  return process.env.SLACK_ONCALL_BOT_TOKEN || process.env.SLACK_BOT_TOKEN;
}

function declarationBlocks(armedAt) {
  const armTime = armedAt
    ? new Intl.DateTimeFormat('en-US', {
      timeZone: process.env.AUTOMATIONS_DEMO_TZ || DEFAULT_TIME_ZONE,
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(armedAt))
    : 'the arm time';
  const repo = process.env.AUTOMATIONS_DEMO_STANDING_REPO_URL
    || `https://github.com/${STANDING_REPO}`;
  const service = process.env.AUTOMATIONS_DEMO_SERVICE_TAG || 'automations-service';
  const ic = process.env.AUTOMATIONS_DEMO_IC_NAME || 'Maya Chen';
  return [
    { type: 'header', text: { type: 'plain_text', text: 'SEV-1 — Scheduled automations failing', emoji: true } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Incident Commander:*\n${ic}` },
        { type: 'mrkdwn', text: '*Detection:*\nReported by an employee; no monitor fired' },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `Since ~${armTime} all scheduled automations are failing` },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Service: \`${service}\` | Standing repo: ${repo}` }],
    },
  ];
}

async function postDeclaration(channel) {
  const text = 'SEV-1 — Scheduled automations failing. Since the arm time, all scheduled automations are failing.';
  return postMessage(slackToken(), channel.id, text, declarationBlocks(state.armedAt));
}

function startChatter(channel, declaredAtMs) {
  CHATTER.forEach((line, index) => {
    scheduleTimer(async () => {
      if (state.runState !== 'declared') return;
      try {
        await postPersonaMessage(
          slackToken(),
          channel.id,
          renderChatterText(line.text),
          line.username,
          line.icon,
        );
        state.chatterPosted += 1;
      } catch (error) {
        logger.warn('Automations demo persona message failed', {
          channel: channel.name,
          error: error.message,
        });
      }
    }, Math.max(index * 3000, line.afterMs - (Date.now() - declaredAtMs)));
  });
}

function getChannelLink(channel) {
  const team = process.env.SLACK_TEAM_ID;
  return team
    ? `https://app.slack.com/client/${team}/${channel.id}`
    : `https://slack.com/app_redirect?channel=${channel.id}`;
}

async function inviteDevin(channelId) {
  if (!process.env.DEVIN_SLACK_USER_ID) return;
  await inviteToChannel(slackToken(), channelId, [process.env.DEVIN_SLACK_USER_ID]);
}

/**
 * Datadog's Slack integration creates the incident channel on its own
 * schedule, so the channel is discovered by the `incident-<publicId>-`
 * name marker and everything channel-bound (card, Devin invite, chatter)
 * happens once it appears. Chatter timings stay anchored to declaration.
 */
function startChannelDiscovery(publicId, declaredAtMs) {
  const marker = `incident-${publicId}-`;
  let attempts = 0;
  const locate = async () => {
    if (state.runState !== 'declared') return;
    attempts += 1;
    let channel = null;
    try {
      channel = await findChannelByNameFragment(slackToken(), marker);
    } catch (error) {
      logger.warn('Automations demo channel lookup failed', { marker, error: error.message });
    }
    if (state.runState !== 'declared') return;
    if (!channel) {
      if (attempts >= CHANNEL_LOOKUP_MAX_ATTEMPTS) {
        logger.warn('Automations demo incident channel never appeared', { marker });
        return;
      }
      scheduleTimer(locate, CHANNEL_LOOKUP_INTERVAL_MS);
      return;
    }
    try {
      await joinChannel(slackToken(), channel.id);
    } catch (error) {
      const permanent =
        /Slack API error: (missing_scope|invalid_auth|account_inactive|token_revoked|is_archived|channel_not_found|method_not_supported_for_channel_type)/.test(
          error.message,
        );
      logger.warn('Automations demo channel join failed', { channel: channel.name, error: error.message });
      if (state.runState !== 'declared') return;
      if (permanent || attempts >= CHANNEL_LOOKUP_MAX_ATTEMPTS) {
        logger.warn('Automations demo gave up joining the incident channel', { channel: channel.name });
        return;
      }
      scheduleTimer(locate, CHANNEL_LOOKUP_INTERVAL_MS);
      return;
    }
    if (state.runState !== 'declared') return;
    state.channel = channel;
    try {
      await postDeclaration(channel);
    } catch (error) {
      logger.warn('Automations demo declaration card failed', { channel: channel.name, error: error.message });
    }
    try {
      await inviteDevin(channel.id);
    } catch (error) {
      logger.warn('Automations demo Devin invite failed', { error: error.message });
    }
    startChatter(channel, declaredAtMs);
  };
  scheduleTimer(locate, CHANNEL_LOOKUP_INTERVAL_MS);
}

async function declare(options = {}) {
  if (!options.smoke && state.smokeInProgress) {
    const error = new Error('Cannot declare while a smoke run is in progress');
    error.statusCode = 400;
    throw error;
  }
  if (state.stopPromise) {
    const error = new Error('Cannot declare while the incident is stopping');
    error.statusCode = 400;
    throw error;
  }
  if (state.runState === 'declared') {
    return {
      ok: true,
      alreadyActive: true,
      publicId: state.incident?.publicId ?? null,
      channel: state.channel?.name ?? null,
      channelLink: state.channel ? getChannelLink(state.channel) : null,
    };
  }
  if (state.declarePromise) {
    return state.declarePromise.then((result) => ({ ...result, alreadyActive: true }));
  }
  state.declarePromise = (async () => {
    if (!state.armedAt) {
      try {
        const standing = await statusStanding();
        if (standing.armed && standing.armed_at) {
          state.armedAt = standing.armed_at;
          state.runState = 'armed';
        }
      } catch (error) {
        logger.warn('Automations demo could not read standing arm state', { error: error.message });
      }
    }
    if (!state.armedAt) {
      const error = new Error('Arm the standing instance before declaring the incident');
      error.statusCode = 400;
      throw error;
    }
    if (!slackToken()) {
      throw new Error('Slack is not configured: set SLACK_ONCALL_BOT_TOKEN or SLACK_BOT_TOKEN');
    }
    const runRef = `run-${crypto.randomBytes(6).toString('hex')}`;
    const incident = await declareDatadogIncident({
      title: `Scheduled automations failing${options.smoke ? ' [smoke]' : ''}`,
      summary: 'All scheduled automations are failing; reported by an employee, no monitor fired.',
      runRef,
      repoUrl: process.env.AUTOMATIONS_DEMO_STANDING_REPO_URL || `https://github.com/${STANDING_REPO}`,
    });
    if (!incident) {
      const error = new Error('Datadog Incident Management is not configured: set DD_API_KEY and DD_INCIDENT_APP_KEY');
      error.statusCode = 503;
      throw error;
    }
    state.incident = incident;
    state.channel = null;
    state.declaredAt = new Date().toISOString();
    state.runState = 'declared';
    state.chatterPosted = 0;
    startChannelDiscovery(incident.publicId, Date.parse(state.declaredAt));
    const runWindow = envNumber('AUTOMATIONS_DEMO_RUN_WINDOW_MS', DEFAULT_RUN_WINDOW_MS);
    state.autoStopAt = new Date(Date.now() + runWindow).toISOString();
    scheduleTimer(() => stop('auto-stop'), runWindow);
    return {
      ok: true,
      alreadyActive: false,
      publicId: incident.publicId,
      channel: null,
      channelLink: null,
      autoStopAt: state.autoStopAt,
    };
  })();
  try {
    return await state.declarePromise;
  } finally {
    state.declarePromise = null;
  }
}

async function closeDevinPullRequests() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    logger.warn('Skipping standing-repo PR cleanup: GITHUB_TOKEN/GH_TOKEN is not configured');
    return;
  }
  let repo = STANDING_REPO;
  if (process.env.AUTOMATIONS_DEMO_STANDING_REPO_URL) {
    try {
      const url = new URL(process.env.AUTOMATIONS_DEMO_STANDING_REPO_URL);
      const parts = url.pathname.split('/').filter(Boolean);
      if (!['github.com', 'www.github.com'].includes(url.hostname)
        || url.search || url.hash || parts.length !== 2
        || !/^[A-Za-z0-9_.-]+$/.test(parts[0])
        || !/^[A-Za-z0-9_.-]+(?:\.git)?$/.test(parts[1])) {
        throw new Error('expected a GitHub owner/name URL');
      }
      repo = `${parts[0]}/${parts[1].replace(/\.git$/, '')}`;
    } catch (error) {
      logger.warn('Skipping standing-repo PR cleanup: invalid AUTOMATIONS_DEMO_STANDING_REPO_URL', {
        error: error.message,
      });
      return;
    }
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
  };
  try {
    const response = await axios.get(
      `https://api.github.com/repos/${repo}/pulls`,
      { headers, params: { state: 'open', per_page: 100 }, timeout: 10000 },
    );
    for (const pull of response.data || []) {
      if (pull.head?.ref?.startsWith('devin/')) {
        try {
          await axios.patch(
            `https://api.github.com/repos/${repo}/pulls/${pull.number}`,
            { state: 'closed' },
            { headers, timeout: 10000 },
          );
        } catch (error) {
          logger.warn('Standing-repo PR close failed', {
            pullNumber: pull.number,
            error: error.message,
          });
        }
      }
    }
  } catch (error) {
    logger.warn('Standing-repo PR cleanup failed', { error: error.message });
  }
}

async function stop(reason = 'manual') {
  if (state.stopPromise) return state.stopPromise;
  if (!state.declarePromise && ['idle', 'stopped'].includes(state.runState)) {
    cancelTimers();
    state.scheduledDeclareAt = null;
    state.scheduledArmAt = null;
    return { ok: true, stopped: false, state: state.runState };
  }
  state.stopPromise = (async () => {
    if (state.declarePromise) {
      try {
        await state.declarePromise;
      } catch (error) {
        logger.warn('Automations demo declaration failed during stop', { error: error.message });
      }
    }
    state.runState = 'stopping';
    state.armedAt = null;
    cancelTimers();
    state.scheduledDeclareAt = null;
    state.scheduledArmAt = null;
    if (state.channel) {
      try {
        await postMessage(
          slackToken(),
          state.channel.id,
          'The automations incident demo has stopped. Datadog archives this channel after the incident resolves.',
        );
      } catch (error) {
        logger.warn('Automations demo wrap message failed', { error: error.message });
      }
    }
    try {
      await disarmStanding();
    } catch (error) {
      logger.warn('Standing instance disarm failed during cleanup', { error: error.message });
    }
    await closeDevinPullRequests();
    if (state.incident) {
      try {
        await resolveDatadogIncident(state.incident.id);
      } catch (error) {
        logger.warn('Automations demo Datadog incident resolve failed', {
          publicId: state.incident.publicId,
          error: error.message,
        });
      }
      state.incident = null;
    }
    state.runState = 'stopped';
    state.autoStopAt = null;
    logger.info('Automations demo stopped', { reason, channel: state.channel?.name });
    return { ok: true, stopped: true };
  })();
  try {
    return await state.stopPromise;
  } finally {
    state.stopPromise = null;
  }
}

function schedule(declareAt) {
  if (state.smokeInProgress) {
    const error = new Error('Cannot schedule while a smoke run is in progress');
    error.statusCode = 400;
    throw error;
  }
  if (state.runState === 'declared' || state.declarePromise || state.stopPromise) {
    const error = new Error('Cannot reschedule while an incident run is active or stopping');
    error.statusCode = 400;
    throw error;
  }
  const target = new Date(declareAt);
  if (typeof declareAt !== 'string' || Number.isNaN(target.getTime())) {
    const error = new Error('declareAt must be a valid ISO date');
    error.statusCode = 400;
    throw error;
  }
  if (target.getTime() <= Date.now()) {
    const error = new Error('declareAt must be in the future');
    error.statusCode = 400;
    throw error;
  }
  if (target.getTime() - Date.now() < MIN_SAFE_TO_DECLARE_MS) {
    const error = new Error('declareAt must be at least 30 minutes in the future for error accumulation');
    error.statusCode = 400;
    throw error;
  }
  const armAt = target.getTime() - 45 * 60 * 1000;
  cancelTimers();
  state.scheduledArmAt = new Date(Math.max(Date.now(), armAt)).toISOString();
  state.scheduledDeclareAt = target.toISOString();
  scheduleTimer(async () => {
    try {
      await arm();
    } catch (error) {
      logger.error('Automations demo scheduled arm failed', { error: error.message });
    }
  }, armAt - Date.now());
  scheduleTimer(async () => {
    try {
      const standing = await statusStanding();
      if (!(Number(standing.errors_since_arm) > 0)) {
        throw new Error('Automations demo scheduled declare blocked: no errors are flowing');
      }
      await declare();
    } catch (error) {
      logger.error('Automations demo scheduled declare failed', { error: error.message });
    } finally {
      if (state.scheduledDeclareAt === target.toISOString()) {
        state.scheduledDeclareAt = null;
        state.scheduledArmAt = null;
      }
    }
  }, target.getTime() - Date.now());
  return {
    ok: true,
    scheduledArmAt: state.scheduledArmAt,
    scheduledDeclareAt: state.scheduledDeclareAt,
  };
}

async function smoke() {
  const hasPendingSchedule = state.scheduledDeclareAt
    && Date.parse(state.scheduledDeclareAt) > Date.now();
  if (state.stopPromise || state.declarePromise || state.armedAt
    || ['armed', 'declared', 'stopping'].includes(state.runState) || hasPendingSchedule) {
    const error = new Error('Cannot run smoke while a presenter demo is in progress');
    error.statusCode = 400;
    throw error;
  }
  let result;
  let smokeRunCreated = false;
  state.smokeInProgress = true;
  try {
    await arm('CUST_1', { smoke: true });
    smokeRunCreated = true;
    const accumulationWait = envNumber(
      'AUTOMATIONS_DEMO_SMOKE_ACCUMULATION_WAIT_MS',
      MIN_SAFE_TO_DECLARE_MS,
    );
    if (accumulationWait > 0) {
      await new Promise((resolve) => setTimeout(resolve, accumulationWait));
    }
    result = await declare({ smoke: true });
    const deadline = Date.now() + SMOKE_POLL_WINDOW_MS;
    let found = false;
    while (Date.now() < deadline) {
      if (!state.channel) {
        await new Promise((resolve) => setTimeout(resolve, 30 * 1000));
        continue;
      }
      const messages = await getChannelHistory(
        slackToken(),
        state.channel.id,
        { limit: 100, oldest: Date.parse(state.declaredAt) / 1000 },
      );
      found = messages.some((message) => {
        const fromDevin = !process.env.DEVIN_SLACK_USER_ID
          || message.user === process.env.DEVIN_SLACK_USER_ID;
        return fromDevin && /root[- ]cause/i.test(message.text || '');
      });
      if (found) break;
      await new Promise((resolve) => setTimeout(resolve, 30 * 1000));
    }
    if (!found) throw new Error('No Devin root-cause post appeared within 20 minutes');
    return { ok: true, success: true, ...result };
  } catch (error) {
    try {
      await postMessage(
        slackToken(),
        process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID,
        `Automations demo smoke failed: ${error.message}`,
      );
    } catch (alertError) {
      logger.warn('Automations smoke alert failed', { error: alertError.message });
    }
    return { ok: false, success: false, error: error.message };
  } finally {
    try {
      if (smokeRunCreated && state.smokeInProgress) {
        await stop('smoke');
      }
    } finally {
      state.smokeInProgress = false;
    }
  }
}

function getState() {
  return {
    ok: true,
    runState: state.runState,
    declare_in_progress: Boolean(state.declarePromise),
    armed_at: state.armedAt,
    declared_at: state.declaredAt,
    channel: state.channel ? {
      name: state.channel.name,
      link: getChannelLink(state.channel),
    } : null,
    incident_public_id: state.incident?.publicId ?? null,
    chatter_posted: state.chatterPosted,
    chatter_total: CHATTER.length,
    auto_stop_at: state.autoStopAt,
    scheduled_declare_at: state.scheduledDeclareAt,
    scheduled_arm_at: state.scheduledArmAt,
    smoke_in_progress: state.smokeInProgress,
    safe_to_declare: false,
  };
}

function adoptStandingArm(standing) {
  if (!state.stopPromise && !['stopping', 'stopped'].includes(state.runState)
    && !state.armedAt && standing.armed && standing.armed_at) {
    state.armedAt = standing.armed_at;
    state.runState = 'armed';
    return true;
  }
  return false;
}

async function getStatus() {
  try {
    const standing = await statusStanding();
    adoptStandingArm(standing);
    const result = getState();
    result.standing_instance = { reachable: true };
    result.errors_since_arm = standing.errors_since_arm;
    result.dlq_depth = standing.dlq_depth;
    result.emitter_heartbeat_age_s = standing.emitter_heartbeat_age_s;
    result.safe_to_declare = Boolean(
      standing.armed
      && state.armedAt
      && Date.now() - Date.parse(state.armedAt) >= MIN_SAFE_TO_DECLARE_MS
      && Number(standing.errors_since_arm) > 0,
    );
    return result;
  } catch (error) {
    const result = getState();
    result.standing_instance = { reachable: false, error: error.message };
    result.errors_since_arm = null;
    result.dlq_depth = null;
    result.emitter_heartbeat_age_s = null;
    return result;
  }
}

function resetForTests() {
  cancelTimers();
  Object.assign(state, {
    runState: 'idle',
    armedAt: null,
    declaredAt: null,
    channel: null,
    incident: null,
    chatterPosted: 0,
    autoStopAt: null,
    scheduledDeclareAt: null,
    scheduledArmAt: null,
    declarePromise: null,
    stopPromise: null,
    smokeInProgress: false,
  });
}

module.exports = {
  arm,
  declare,
  getStatus,
  resetForTests,
  schedule,
  smoke,
  stop,
  tokenMatches,
};
