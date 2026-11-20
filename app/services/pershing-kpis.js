const axios = require('axios');
const kpiData = require('../../config/pershing/kpi-days.json');
const personaScript = require('../../config/pershing/kpi-personas.json');
const {
  postPersonaMessage, inviteToChannel, joinChannel, getThreadReplies, getChannelHistory, deleteMessage,
} = require('./slack');
const { sendDevinSessionMessage } = require('./devin-api');
const logger = require('../telemetry/logger');

const DEFAULT_CHANNEL_ID = 'C0CKGCDNJ2V';
const DEFAULT_BOT_ID = 'bot-59656379ddc5470281166b1458334c2c';
const DEFAULT_BOT_SLACK_ID = 'U0CK6TNG7T3';
const DEFAULT_SEED = { from: '2026-11-09', to: '2026-11-15' };
const DROP_THRESHOLD_PTS = 2;
const BASELINE_DAYS = 7;
const DEFAULT_BOT_WEBHOOK_URL = 'https://devin-gtm.devinenterprise.com/api/webhooks/automations/org_69IXJFLrljx8zSAw/auto-2203779474c643fb9262f44c8fd61791';
const ANDROID_REPO = 'COG-GTM/android-demos';
const ANDROID_BRANCH = 'devin/1795069865-pershing-access-android';

const days = kpiData.days;
const state = {
  lastDate: null, lastRun: null, busy: false, handoffTimer: null, personaTimers: [],
};

const channelId = () => process.env.PERSHING_KPI_CHANNEL_ID || DEFAULT_CHANNEL_ID;
const slackToken = () => process.env.PERSHING_KPI_SLACK_TOKEN || process.env.SLACK_ONCALL_BOT_TOKEN || '';
const botId = () => process.env.PERSHING_KPI_BOT_ID || DEFAULT_BOT_ID;
const botSlackId = () => process.env.PERSHING_KPI_BOT_SLACK_ID || DEFAULT_BOT_SLACK_ID;
const publicBase = () => (process.env.PUBLIC_BASE_URL || 'https://devindemos.com').replace(/\/$/, '');
const iconUrl = (icon) => (icon && icon.startsWith('/') ? `${publicBase()}${icon}` : icon);

function dayIndex(date) {
  const i = days.findIndex((d) => d.date === date);
  if (i < 0) throw Object.assign(new Error(`No KPI data for ${date}`), { status: 400 });
  return i;
}

function combined(day) {
  const { android, web } = day;
  const dau = android.dau + web.dau;
  const weighted = (key) => (android[key] * android.dau + web[key] * web.dau) / dau;
  return {
    dau,
    transfersStarted: android.transfersStarted + web.transfersStarted,
    crashFree: weighted('crashFree'),
    p95LatencyMs: weighted('p95LatencyMs'),
  };
}

function androidBaseline(i) {
  const window = days.slice(Math.max(0, i - BASELINE_DAYS), i).filter((d) => d.android.appVersion !== '2.4.0');
  if (!window.length) return null;
  return window.reduce((sum, d) => sum + d.android.completionRate, 0) / window.length;
}

function analyzeDay(date) {
  const i = dayIndex(date);
  const day = days[i];
  const prev = i > 0 ? days[i - 1] : null;
  const baseline = androidBaseline(i);
  const dropPts = baseline == null ? 0 : (baseline - day.android.completionRate) * 100;
  const prevBaseline = prev ? androidBaseline(i - 1) : null;
  const prevDropPts = prev && prevBaseline != null ? (prevBaseline - prev.android.completionRate) * 100 : 0;
  const isDrop = dropPts >= DROP_THRESHOLD_PTS;
  return { date, day, prev, baseline, dropPts, isDrop, isNewDrop: isDrop && prevDropPts < DROP_THRESHOLD_PTS };
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;
const thousands = (v) => `${(v / 1000).toFixed(1)}k`;
function relDelta(cur, prev) {
  if (prev == null) return '';
  const d = (cur / prev - 1) * 100;
  return ` (${d >= 0 ? '+' : ''}${d.toFixed(1)}% DoD)`;
}
function ptsDelta(cur, prev) {
  if (prev == null) return '';
  const d = (cur - prev) * 100;
  if (Math.abs(d) < 0.05) return ' (flat)';
  return ` (${d > 0 ? '▲' : '▼'}${Math.abs(d).toFixed(1)} pts DoD)`;
}
function msDelta(cur, prev) {
  if (prev == null) return '';
  const d = Math.round(cur - prev);
  return d === 0 ? ' (flat)' : ` (${d > 0 ? '+' : ''}${d} ms DoD)`;
}
function dateLabel(date) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

function renderDay(date) {
  const a = analyzeDay(date);
  const { day, prev } = a;
  const c = combined(day);
  const pc = prev ? combined(prev) : null;
  const status = a.isDrop ? ':red_circle:' : ':large_green_circle:';
  const lines = [
    `${status} *Pershing Access daily KPIs: ${dateLabel(date)}*`,
    `• DAU *${thousands(c.dau)}*${relDelta(c.dau, pc && pc.dau)} (Android ${thousands(day.android.dau)}, web ${thousands(day.web.dau)})`,
    `• Transfers started *${thousands(c.transfersStarted)}*${relDelta(c.transfersStarted, pc && pc.transfersStarted)}`,
    `• Transfer completion: web *${pct(day.web.completionRate)}*${ptsDelta(day.web.completionRate, prev && prev.web.completionRate)}, `
      + `Android *${pct(day.android.completionRate)}*${ptsDelta(day.android.completionRate, prev && prev.android.completionRate)}`,
    `• Crash-free sessions *${pct(c.crashFree)}* · p95 API latency *${Math.round(c.p95LatencyMs)} ms*${msDelta(c.p95LatencyMs, pc && pc.p95LatencyMs)}`,
    `• Android build ${day.android.appVersion}${day.date === kpiData.release.rolledOut ? ` (2.4.0 rollout started today)` : ''}`,
  ];
  if (a.isDrop) {
    lines.push(`:warning: *Android transfer completion is ${a.dropPts.toFixed(1)} pts below its 7-day pre-2.4.0 average (${pct(a.baseline)})*; web is flat.`);
  }
  return { text: lines.join('\n'), analysis: a };
}

function orgChart() {
  return personaScript.personas.map((p) => `${p.username}: ${p.role}`).join(' ');
}

function buildBotPage({ date, threadTs, analysis }) {
  const ch = channelId();
  const { day, baseline, dropPts } = analysis;
  const expert = personaScript.personas.find((p) => p.id === personaScript.handoff.persona);
  const { tag } = personaScript.handoff;
  return [
    `KPI alert from #bny-pershing-access-android-app-metrics (Slack channel ${ch}). Investigate it in that post's thread: channel ${ch}, thread_ts ${threadTs}. Reply only in that thread.`,
    '',
    `The daily Pershing Access KPI post for ${date} shows Android transfer completion at ${pct(day.android.completionRate)}, ${dropPts.toFixed(1)} pts below its 7-day pre-release average of ${pct(baseline)}. Web is flat at ${pct(day.web.completionRate)}. Android 2.4.0 started rolling out on ${kpiData.release.rolledOut}.`,
    '',
    `Your team (they post through a Slack app, so they are not Slack users you can @mention; write their names as plain text): ${orgChart()}`,
    '',
    'What to do:',
    '1. Post a one-line note in the thread that you are looking into it.',
    '1b. Then post a short prose summary of the past week of KPI trends (DAU, transfers, completion by platform, crash-free sessions, p95 latency; the daily dashboard image on each post shows them) and say which one warrants investigation and why.',
    `2. Find which segment carries the drop and why. The data and app are in ${ANDROID_REPO} on branch \`${ANDROID_BRANCH}\`, app \`apps/b113a373\` (Pershing Access): daily KPIs in \`metrics/daily_kpis.csv\`, the per-session transfer funnel in \`metrics/events_sample.csv\` (segment by app_version and os_version), and the transfer flow code (start with the confirm step and the 2.4.0 changes).`,
    '3. Post your analysis in the thread as a short prose write-up, the way a teammate would: two or three plain-language paragraphs, no bullet lists or bold headings. Cover the segment, its share of Android sessions, how much of the drop it explains, the root cause with file and line, and the proposed fix.',
    '4. Follow up on your own analysis: check it a second way (for example, recompute Android completion without the affected segment and compare it with web and the pre-2.4.0 baseline) and post what that confirms. With that follow-up, attach a polished, self-contained HTML report of the analysis to the thread: a daily completion trend by platform, the funnel by OS version for 2.4.0, the root cause with the code excerpt, and the proposed fix.',
    tag
      ? `5. Then hand it to ${tag.name}, the subject-matter expert (a real Slack user, ${tag.slackUserId}), in its own message, using exactly this line with a real Slack mention: "I've done this analysis, <@${tag.slackUserId}>, can you jump in and look deeper?" In the same message, on a new line, loop in the other relevant teammates by name with one sentence each on what you need from them (for example @${expert.username} on the confirm-flow code, @Marcus Chen for the rollout decision, @Sofia Alvarez for the business and support message).`
      : `5. Then hand it to the expert in its own message, using exactly this line: "I've done this analysis, @${expert.username}, can you jump in and look deeper?" In the same message, on a new line, loop in the other relevant teammates by name with one sentence each on what you need from them (for example @Marcus Chen for the rollout decision, @Sofia Alvarez for the business and support message).`,
    '6. Questions from the team are forwarded to you here as they are posted. Answer each person by name in the thread.',
    `7. If you are asked for the fix, open a PR against \`${ANDROID_BRANCH}\` with a regression test for Android 12 and link it in the thread. Never merge it; the planted bug must stay on that branch for the demo.`,
    '',
    'This is a demo with synthetic data; treat it as real and do not mention that it is staged.',
  ].join('\n');
}

function relayPersonaReply(persona, text, threadTs) {
  return [
    `New reply in the #bny-pershing-access-android-app-metrics KPI thread you are investigating (channel ${channelId()}, thread_ts ${threadTs}).`,
    `${persona.username} (${persona.role}) wrote: "${text}"`,
    `Answer ${persona.username.split(' ')[0]} by name in that thread.`,
  ].join('\n');
}

function playScript(token, channel, threadTs) {
  const byId = Object.fromEntries(personaScript.personas.map((p) => [p.id, p]));
  for (const line of personaScript.script) {
    const persona = byId[line.persona];
    if (!persona) continue;
    state.personaTimers.push(setTimeout(async () => {
      try {
        await postPersonaMessage(token, channel, line.text, persona.username, iconUrl(persona.icon), threadTs);
        if (line.asksBot) await pageBot({ message: relayPersonaReply(persona, line.text, threadTs), threadTs });
      } catch (err) {
        logger.warn('Pershing KPI persona message failed', { persona: persona.id, error: err.message });
      }
    }, line.afterHandoffMs).unref());
  }
}

const HANDOFF_WORDS = /look deeper|jump in|hand(ing|ed)? (this|it) (over |off )?to you|over to you|take it from here/i;

function botHandedOff(messages, expertName, tagSlackId) {
  const first = expertName.split(' ')[0];
  const mention = new RegExp(`@[*_\\s]*${first}`, 'i');
  const named = new RegExp(`\\b${first}\\b`, 'i');
  const tagged = (text) => Boolean(tagSlackId) && text.includes(`<@${tagSlackId}>`);
  return messages.some((m) => {
    const text = m.text || '';
    return m.user === botSlackId() && (tagged(text) || mention.test(text) || (named.test(text) && HANDOFF_WORDS.test(text)));
  });
}

// The team joins once the Bot hands the thread to the expert, or after the timeout.
function schedulePersonas(token, channel, threadTs) {
  if ((process.env.PERSHING_KPI_PERSONAS || '').toLowerCase() === 'off') return 0;
  const { persona: expertId, timeoutMs, pollMs } = personaScript.handoff;
  const expert = personaScript.personas.find((p) => p.id === expertId);
  const deadline = Date.now() + timeoutMs;
  clearTimeout(state.handoffTimer);
  const poll = async () => {
    let handedOff = false;
    try {
      handedOff = botHandedOff(await getThreadReplies(token, channel, threadTs), expert.username, personaScript.handoff.tag?.slackUserId);
    } catch (err) {
      logger.warn('Pershing KPI thread poll failed', { error: err.message });
    }
    if (handedOff || Date.now() >= deadline) {
      if (!handedOff) logger.warn('Pershing KPI Bot did not hand off before the timeout; starting personas');
      playScript(token, channel, threadTs);
      return;
    }
    state.handoffTimer = setTimeout(poll, pollMs).unref();
  };
  state.handoffTimer = setTimeout(poll, pollMs).unref();
  return personaScript.script.length;
}

async function postDay(date, { trigger = true } = {}) {
  const token = slackToken();
  if (!token) throw Object.assign(new Error('Slack token not configured'), { status: 503 });
  const channel = channelId();
  const { text, analysis } = renderDay(date);
  const ts = await postKpiPost(token, channel, text, date);
  state.lastDate = date;
  const result = { date, ts, drop: analysis.isDrop, dropPts: Number(analysis.dropPts.toFixed(2)), investigation: null };
  if (!trigger || !analysis.isNewDrop) return result;

  const id = botId();
  if (botSlackId()) {
    await inviteToChannel(token, channel, [botSlackId()]).catch((err) => logger.warn('Pershing KPI bot invite failed', { error: err.message }));
  }
  const page = buildBotPage({ date, threadTs: ts, analysis });
  const paged = await pageBot({ message: page, threadTs: ts });
  const personas = schedulePersonas(token, channel, ts);
  result.investigation = { botId: id, paged: Boolean(paged), via: paged && paged.via, personas };
  if (!paged) logger.warn('Pershing KPI bot page failed; check the Bot\'s "Who can message" setting', { botId: id });
  return result;
}

async function postKpiPost(token, channel, text, date) {
  const reporter = personaScript.reporter;
  const response = await axios.post('https://slack.com/api/chat.postMessage', {
    channel,
    text,
    username: reporter.username,
    icon_url: iconUrl(reporter.icon),
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text } },
      { type: 'image', image_url: `${publicBase()}/pershing/kpi/${date}.png`, alt_text: `Pershing Access daily metrics, ${date}` },
    ],
  }, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 10000 });
  if (!response.data.ok) throw new Error(`Slack API error: ${response.data.error}`);
  return response.data.ts;
}

async function pageBot({ message, threadTs }) {
  const webhookUrl = process.env.PERSHING_KPI_BOT_WEBHOOK_URL || process.env.BNY_IOS_BOT_WEBHOOK_URL || DEFAULT_BOT_WEBHOOK_URL;
  const webhookSecret = process.env.BNY_IOS_BOT_WEBHOOK_SECRET || process.env.PERSHING_KPI_BOT_WEBHOOK_SECRET;
  if (webhookSecret) {
    try {
      const response = await axios.post(webhookUrl, {
        bot_id: botId(),
        message,
        source: 'devindemos.com',
        slack_channel_id: channelId(),
        slack_thread_ts: threadTs,
      }, {
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': webhookSecret },
        timeout: 15000,
      });
      return { via: 'webhook', status: response.status };
    } catch (error) {
      logger.error('Pershing KPI bot webhook page failed', { status: error.response?.status, error: error.message });
      return null;
    }
  }
  const response = await sendDevinSessionMessage(botId(), message, {
    orgId: process.env.DEVIN_ONCALL_ORG_ID || process.env.DEVIN_ORG_ID,
    apiKey: process.env.DEVIN_ONCALL_SERVICE_KEY,
  });
  return response ? { via: 'v3', url: response.url } : null;
}

async function ensureJoined(token, channel) {
  await joinChannel(token, channel).catch((err) => logger.warn('Pershing KPI channel join failed', { error: err.message }));
}

function datesBetween(from, to) {
  const start = dayIndex(from);
  const end = dayIndex(to);
  if (end < start) throw Object.assign(new Error('`to` must not be before `from`'), { status: 400 });
  return days.slice(start, end + 1).map((d) => d.date);
}

async function exclusive(fn) {
  if (state.busy) throw Object.assign(new Error('A KPI run is already in progress'), { status: 429 });
  state.busy = true;
  try {
    return await fn();
  } finally {
    state.busy = false;
  }
}

function nextDate() {
  if (!state.lastDate) return '2026-11-16';
  return days[dayIndex(state.lastDate) + 1]?.date || null;
}

async function seed({ from = DEFAULT_SEED.from, to = DEFAULT_SEED.to } = {}) {
  const dates = datesBetween(from, to);
  return exclusive(async () => {
    await ensureJoined(slackToken(), channelId());
    const posts = [];
    for (const date of dates) posts.push(await postDay(date, { trigger: false }));
    state.lastRun = { kind: 'seed', at: new Date().toISOString(), posts };
    return state.lastRun;
  });
}

async function nextDay({ date } = {}) {
  const target = date || nextDate();
  if (!target) throw Object.assign(new Error('No more KPI days; reset the sequence or pick a date'), { status: 409 });
  dayIndex(target);
  return exclusive(async () => {
    const post = await postDay(target);
    state.lastRun = { kind: 'day', at: new Date().toISOString(), posts: [post] };
    return state.lastRun;
  });
}

// Deletes this demo's posts (KPI posts and persona replies) and asks the Bot to delete its own replies.
async function clearChannel() {
  const token = slackToken();
  if (!token) throw Object.assign(new Error('Slack token not configured'), { status: 503 });
  const channel = channelId();
  const personaNames = new Set(personaScript.personas.map((p) => p.username));
  return exclusive(async () => {
    cancelScheduled();
    const history = await getChannelHistory(token, channel, { limit: 200 });
    const reporterNames = [personaScript.reporter.username, ...(personaScript.reporter.legacyUsernames || [])];
    const roots = history.filter((m) => reporterNames.includes(m.username));
    const threads = new Map();
    for (const root of roots) {
      threads.set(root.ts, root.reply_count ? (await getThreadReplies(token, channel, root.ts)).slice(1) : []);
    }
    const botThreads = roots.filter((r) => threads.get(r.ts).some((m) => m.user === botSlackId())).map((r) => r.ts);
    let botAsked = false;
    if (botThreads.length) {
      botAsked = Boolean(await pageBot({
        message: `Demo reset for #bny-pershing-access-android-app-metrics (channel ${channel}): delete every message you posted in the threads with thread_ts ${botThreads.join(', ')}, including attached files. Do not post anything.`,
        threadTs: botThreads[0],
      }));
    }
    let deleted = 0;
    for (const root of roots) {
      for (const reply of threads.get(root.ts)) {
        if (personaNames.has(reply.username)) {
          await deleteMessage(token, channel, reply.ts);
          deleted += 1;
        }
      }
      // Keep a root the Bot still has replies under when it could not be asked, so a retry finds it.
      if (!botAsked && botThreads.includes(root.ts)) continue;
      await deleteMessage(token, channel, root.ts);
      deleted += 1;
    }
    state.lastDate = null;
    state.lastRun = null;
    return { deleted, botThreads, botAsked };
  });
}

function getState() {
  return {
    channelId: channelId(),
    botId: botId(),
    botSlackId: botSlackId(),
    lastDate: state.lastDate,
    nextDate: nextDate(),
    seedRange: DEFAULT_SEED,
    dates: days.map((d) => d.date),
    lastRun: state.lastRun,
  };
}

function cancelScheduled() {
  clearTimeout(state.handoffTimer);
  state.handoffTimer = null;
  state.personaTimers.forEach(clearTimeout);
  state.personaTimers = [];
}

function resetState() {
  cancelScheduled();
  state.lastDate = null;
  state.lastRun = null;
}

module.exports = {
  renderDay, analyzeDay, buildBotPage, seed, nextDay, postDay, getState, resetState, clearChannel,
};
