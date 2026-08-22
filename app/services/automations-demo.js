const crypto = require('crypto');
const axios = require('axios');
const logger = require('../telemetry/logger');
const {
  archiveChannel,
  createChannel,
  getChannelHistory,
  inviteToChannel,
  postMessage,
  postPersonaMessage,
} = require('./slack');

const DEFAULT_RUN_WINDOW_MS = 60 * 60 * 1000;
const MIN_SAFE_TO_DECLARE_MS = 30 * 60 * 1000;
const DEFAULT_TIME_ZONE = 'America/Los_Angeles';
const STANDING_REPO = 'ananthv26-cog-demo-repos/automations-service';
const CHANNEL_PREFIX = 'sev-1-incident';
const CHATTER = [
  { afterMs: 30 * 1000, username: 'Maya Chen (IC)', icon: ':female-technologist:', text: 'sorry to the platform team you all got added, we don\'t have a team on automations' },
  { afterMs: 60 * 1000, username: 'Ethan Brooks (ENG)', icon: ':man-technologist:', text: 'did we ship anything yesterday? I don\'t see a deploy' },
  { afterMs: 120 * 1000, username: 'Priya Shah (ENG_B)', icon: ':woman-technologist:', text: 'is the queue itself down? AWS status is green' },
  { afterMs: 180 * 1000, username: 'Maya Chen (IC)', icon: ':female-technologist:', text: 'looks like one customer has been poisoning our automations queue somehow' },
  { afterMs: 240 * 1000, username: 'Jordan Ellis (BIZ)', icon: ':briefcase:', text: 'customers are asking — blast radius? is this a sev2?' },
];

const state = {
  runState: 'idle',
  armedAt: null,
  declaredAt: null,
  channel: null,
  chatterPosted: 0,
  autoStopAt: null,
  scheduledDeclareAt: null,
  scheduledArmAt: null,
  archiveCandidates: [],
  timers: new Set(),
  activeRun: false,
  declarePromise: null,
  stopPromise: null,
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
  const baseUrl = (process.env.AUTOMATIONS_SERVICE_BASE_URL || '').replace(/\/+$/, '');
  const token = process.env.AUTOMATIONS_DEMO_SERVICE_TOKEN;
  if (!baseUrl || !token) {
    throw new Error(
      'standing instance unreachable: configure AUTOMATIONS_SERVICE_BASE_URL and AUTOMATIONS_DEMO_SERVICE_TOKEN',
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

async function arm(customer = 'CUST_1') {
  if (state.activeRun) {
    const error = new Error('Cannot arm while an incident run is active');
    error.statusCode = 400;
    throw error;
  }
  const result = await armStanding(customer);
  const hasFutureSchedule = state.scheduledDeclareAt
    && Date.parse(state.scheduledDeclareAt) > Date.now();
  state.channel = null;
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
  for (const timer of state.timers) clearTimeout(timer);
  state.timers.clear();
}

function localDateParts(date, timeZone = process.env.AUTOMATIONS_DEMO_TZ || DEFAULT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  return {
    month: parts.find((part) => part.type === 'month').value,
    day: parts.find((part) => part.type === 'day').value,
  };
}

function baseChannelName(date = new Date(), smoke = false) {
  const { month, day } = localDateParts(date);
  return `${CHANNEL_PREFIX}-${month}${day}-scheduled-automations-failing${smoke ? '-smoke' : ''}`;
}

async function createDemoChannel(date, smoke = false) {
  if (!process.env.SLACK_BOT_TOKEN) {
    throw new Error('Slack is not configured: set SLACK_BOT_TOKEN');
  }
  const base = baseChannelName(date, smoke);
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const name = suffix === 0 ? base : `${base}-${suffix + 1}`;
    try {
      return await createChannel(process.env.SLACK_BOT_TOKEN, name);
    } catch (error) {
      if (error.code !== 'name_taken' && !error.message.includes('Slack API error: name_taken')) {
        throw error;
      }
      logger.info('Automations demo channel name taken; retrying', { name });
    }
  }
  throw new Error('Unable to find an available demo channel name');
}

function declarationBlocks(armedAt) {
  const armTime = armedAt
    ? new Intl.DateTimeFormat('en-US', {
      timeZone: process.env.AUTOMATIONS_DEMO_TZ || DEFAULT_TIME_ZONE,
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(armedAt))
    : 'the arm time';
  const repo = process.env.AUTOMATIONS_STANDING_REPO_URL
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
  return postMessage(process.env.SLACK_BOT_TOKEN, channel.id, text, declarationBlocks(state.armedAt));
}

function startChatter(channel) {
  CHATTER.forEach((line) => {
    scheduleTimer(async () => {
      if (!state.activeRun) return;
      try {
        await postPersonaMessage(
          process.env.SLACK_BOT_TOKEN,
          channel.id,
          line.text,
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
    }, line.afterMs);
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
  await inviteToChannel(process.env.SLACK_BOT_TOKEN, channelId, [process.env.DEVIN_SLACK_USER_ID]);
}

async function declare(options = {}) {
  if (state.stopPromise) {
    const error = new Error('Cannot declare while the incident is stopping');
    error.statusCode = 400;
    throw error;
  }
  if (state.activeRun && state.channel) {
    return {
      ok: true,
      alreadyActive: true,
      channel: state.channel.name,
      channelLink: getChannelLink(state.channel),
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
    const channel = await createDemoChannel(new Date(), Boolean(options.smoke));
    try {
      await postDeclaration(channel);
      state.channel = channel;
      state.declaredAt = new Date().toISOString();
      state.runState = 'declared';
      state.activeRun = true;
      state.chatterPosted = 0;
      startChatter(channel);
      try {
        await inviteDevin(channel.id);
      } catch (error) {
        logger.warn('Automations demo Devin invite failed', { error: error.message });
      }
      const runWindow = envNumber('AUTOMATIONS_DEMO_RUN_WINDOW_MS', DEFAULT_RUN_WINDOW_MS);
      state.autoStopAt = new Date(Date.now() + runWindow).toISOString();
      scheduleTimer(() => stop('auto-stop'), runWindow);
    } catch (error) {
      state.activeRun = false;
      state.channel = null;
      state.declaredAt = null;
      state.chatterPosted = 0;
      state.autoStopAt = null;
      state.scheduledDeclareAt = null;
      state.scheduledArmAt = null;
      state.archiveCandidates.push({
        ...channel,
        createdAt: new Date().toISOString(),
      });
      state.runState = 'armed';
      cancelTimers();
      throw error;
    }
    return {
      ok: true,
      alreadyActive: false,
      channel: channel.name,
      channelLink: getChannelLink(channel),
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
  if (process.env.AUTOMATIONS_STANDING_REPO_URL) {
    try {
      const url = new URL(process.env.AUTOMATIONS_STANDING_REPO_URL);
      const parts = url.pathname.split('/').filter(Boolean);
      if (!['github.com', 'www.github.com'].includes(url.hostname)
        || url.search || url.hash || parts.length !== 2
        || !/^[A-Za-z0-9_.-]+$/.test(parts[0])
        || !/^[A-Za-z0-9_.-]+(?:\.git)?$/.test(parts[1])) {
        throw new Error('expected a GitHub owner/name URL');
      }
      repo = `${parts[0]}/${parts[1].replace(/\.git$/, '')}`;
    } catch (error) {
      logger.warn('Skipping standing-repo PR cleanup: invalid AUTOMATIONS_STANDING_REPO_URL', {
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
        await axios.patch(
          `https://api.github.com/repos/${repo}/pulls/${pull.number}`,
          { state: 'closed' },
          { headers, timeout: 10000 },
        );
      }
    }
  } catch (error) {
    logger.warn('Standing-repo PR cleanup failed', { error: error.message });
  }
}

async function stop(reason = 'manual') {
  if (state.stopPromise) return state.stopPromise;
  if (!state.declarePromise && !state.activeRun && ['idle', 'stopped'].includes(state.runState)) {
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
    state.activeRun = false;
    state.armedAt = null;
    cancelTimers();
    state.scheduledDeclareAt = null;
    state.scheduledArmAt = null;
    if (state.channel) {
      try {
        await postMessage(
          process.env.SLACK_BOT_TOKEN,
          state.channel.id,
          'The automations incident demo has stopped. This channel is archived after the run.',
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
    if (state.channel) {
      state.archiveCandidates.push({
        ...state.channel,
        createdAt: state.declaredAt || new Date().toISOString(),
      });
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

async function archiveStale() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const stale = state.archiveCandidates.filter((channel) => Date.parse(channel.createdAt) <= cutoff);
  let archived = 0;
  for (const channel of stale) {
    try {
      await archiveChannel(process.env.SLACK_BOT_TOKEN, channel.id);
    } catch (error) {
      logger.warn('Automations demo stale channel archive failed', {
        channel: channel.name,
        error: error.message,
      });
      continue;
    }
    state.archiveCandidates = state.archiveCandidates.filter((candidate) => candidate.id !== channel.id);
    archived += 1;
  }
  return { ok: true, archived };
}

function schedule(declareAt) {
  if (state.activeRun) {
    const error = new Error('Cannot reschedule while an incident run is active');
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
      await declare();
    } catch (error) {
      logger.error('Automations demo scheduled declare failed', { error: error.message });
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
  if (state.stopPromise || state.declarePromise || state.activeRun || state.armedAt
    || ['armed', 'declared', 'stopping'].includes(state.runState) || hasPendingSchedule) {
    const error = new Error('Cannot run smoke while a presenter demo is in progress');
    error.statusCode = 400;
    throw error;
  }
  let result;
  let smokeRunCreated = false;
  try {
    await arm();
    smokeRunCreated = true;
    result = await declare({ smoke: true });
    const deadline = Date.now() + 20 * 60 * 1000;
    let found = false;
    while (Date.now() < deadline) {
      const messages = await getChannelHistory(
        process.env.SLACK_BOT_TOKEN,
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
        process.env.SLACK_BOT_TOKEN,
        process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID,
        `Automations demo smoke failed: ${error.message}`,
      );
    } catch (alertError) {
      logger.warn('Automations smoke alert failed', { error: alertError.message });
    }
    return { ok: false, success: false, error: error.message };
  } finally {
    if (smokeRunCreated) {
      await stop('smoke');
    }
  }
}

function getState() {
  return {
    ok: true,
    runState: state.runState,
    armed_at: state.armedAt,
    declared_at: state.declaredAt,
    channel: state.channel ? {
      name: state.channel.name,
      link: getChannelLink(state.channel),
    } : null,
    chatter_posted: state.chatterPosted,
    chatter_total: CHATTER.length,
    auto_stop_at: state.autoStopAt,
    scheduled_declare_at: state.scheduledDeclareAt,
    scheduled_arm_at: state.scheduledArmAt,
    safe_to_declare: false,
  };
}

async function getStatus() {
  const result = getState();
  try {
    const standing = await statusStanding();
    result.standing_instance = { reachable: true };
    result.errors_since_arm = standing.errors_since_arm;
    result.dlq_depth = standing.dlq_depth;
    result.emitter_heartbeat_age_s = standing.emitter_heartbeat_age_s;
    if (!state.stopPromise && !['stopping', 'stopped'].includes(state.runState)
      && !state.armedAt && standing.armed && standing.armed_at) {
      state.armedAt = standing.armed_at;
      state.runState = 'armed';
      result.runState = 'armed';
      result.armed_at = state.armedAt;
    }
    result.safe_to_declare = Boolean(
      standing.armed
      && state.armedAt
      && Date.now() - Date.parse(state.armedAt) >= MIN_SAFE_TO_DECLARE_MS
      && Number(standing.errors_since_arm) > 0,
    );
  } catch (error) {
    result.standing_instance = { reachable: false, error: error.message };
    result.errors_since_arm = null;
    result.dlq_depth = null;
    result.emitter_heartbeat_age_s = null;
  }
  return result;
}

function resetForTests() {
  cancelTimers();
  Object.assign(state, {
    runState: 'idle',
    armedAt: null,
    declaredAt: null,
    channel: null,
    chatterPosted: 0,
    autoStopAt: null,
    scheduledDeclareAt: null,
    scheduledArmAt: null,
    archiveCandidates: [],
    activeRun: false,
    declarePromise: null,
    stopPromise: null,
  });
}

module.exports = {
  arm,
  archiveStale,
  baseChannelName,
  declare,
  getStatus,
  resetForTests,
  schedule,
  smoke,
  stop,
  tokenMatches,
};
