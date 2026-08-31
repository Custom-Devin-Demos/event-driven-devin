const axios = require('axios');
const logger = require('../../telemetry/logger');
const {
  findChannelByNameFragment,
  joinChannel,
  postPersonaMessage,
  getChannelHistory,
} = require('../slack');
const { triggerPhase } = require('./engine');

/**
 * Incident Lab Slack sink: the human side of the incident.
 *
 * Two layers share the incident channel that Datadog's Slack integration
 * creates for the declared incident (the engine never creates channels):
 *
 * 1. Scripted spine — the scenario's `script` lines post on their `atMs`
 *    timeline under persona display names (chat:write.customize), including
 *    the @Devin asks. Lines with an `action` also drive the engine (e.g.
 *    "mitigate" activates the manual mitigation phase so the telemetry
 *    recovers when the persona says it should).
 *
 * 2. Dynamic responder — an optional small-LLM layer that polls channel
 *    history and answers messages from real participants (Devin) in
 *    character, restricted to the facts unlocked at the current point in
 *    the timeline. Requires OPENAI_API_KEY; skipped without it.
 *
 * Required Slack scopes: channels:read, channels:join, chat:write,
 * chat:write.customize, channels:history (responder only).
 */

const CHANNEL_LOOKUP_INTERVAL_MS = 15000;
const RESPONDER_POLL_MS = 20000;

function slackToken() {
  return process.env.SLACK_BOT_TOKEN;
}

function renderLine(text) {
  const devin = process.env.DEVIN_SLACK_USER_ID
    ? `<@${process.env.DEVIN_SLACK_USER_ID}>`
    : 'Devin';
  return text.replace(/\{devin\}/g, devin);
}

function unlockedFacts(scenario, elapsedMs) {
  const facts = [];
  for (const entry of scenario.knowledge || []) {
    if (entry.unlockAtMs <= elapsedMs) facts.push(...entry.facts);
  }
  return facts;
}

function lockedFacts(scenario, elapsedMs) {
  const facts = [];
  for (const entry of scenario.knowledge || []) {
    if (entry.unlockAtMs > elapsedMs) facts.push(...entry.facts);
  }
  return facts;
}

function buildResponderPrompt(scenario, elapsedMs, transcript) {
  const personas = scenario.personas
    .map((p) => `- ${p.id} ("${p.username}"): ${p.role || ''}${(p.canReveal || []).length ? ` May reveal when asked: ${p.canReveal.join(' ')}` : ''}`)
    .join('\n');
  const llm = scenario.llm || {};
  return [
    `You are role-playing the human responders in a live incident Slack channel for the service "${scenario.service}".`,
    `Incident: ${scenario.title} — ${scenario.summary}`,
    `Personas you may speak as:\n${personas}`,
    `Facts currently known to the team (you may use these):\n${unlockedFacts(scenario, elapsedMs).map((f) => `- ${f}`).join('\n') || '- (none yet)'}`,
    `Facts NOT yet known (never state or hint at these):\n${lockedFacts(scenario, elapsedMs).map((f) => `- ${f}`).join('\n') || '- (none)'}`,
    llm.guardrails || '',
    'You are replying to the most recent message(s) from the investigator in the transcript below.',
    'Respond with strict JSON: {"persona": "<persona id>", "text": "<reply>"} to reply, or {"skip": true} if no persona would naturally reply (e.g. the message needs no answer, or answering would reveal locked facts).',
    `Recent transcript:\n${transcript}`,
  ].join('\n\n');
}

async function draftReply(scenario, elapsedMs, transcript) {
  const llm = scenario.llm || {};
  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: llm.model || 'gpt-4o-mini',
      temperature: 0.7,
      max_tokens: 200,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: buildResponderPrompt(scenario, elapsedMs, transcript) }],
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    },
  );
  const content = response.data.choices &&
    response.data.choices[0] &&
    response.data.choices[0].message &&
    response.data.choices[0].message.content;
  if (!content) return null;
  const parsed = JSON.parse(content);
  if (parsed.skip || !parsed.persona || !parsed.text) return null;
  const persona = scenario.personas.find((p) => p.id === parsed.persona);
  if (!persona) return null;
  return { persona, text: parsed.text };
}

function createSlackPersonaSink({ deps = {} } = {}) {
  const api = {
    findChannel: deps.findChannel || findChannelByNameFragment,
    join: deps.join || joinChannel,
    post: deps.post || postPersonaMessage,
    history: deps.history || getChannelHistory,
    draft: deps.draft || draftReply,
    activatePhase: deps.activatePhase || triggerPhase,
  };
  let state = null;

  function addTimer(fn, delayMs) {
    const timer = setTimeout(fn, Math.max(delayMs, 0));
    if (timer.unref) timer.unref();
    state.timers.push(timer);
    return timer;
  }

  function scheduleScript(run) {
    for (const line of run.scenario.script) {
      const persona = run.scenario.personas.find((p) => p.id === line.persona);
      addTimer(async () => {
        if (!state || state.stopped) return;
        try {
          await api.post(
            slackToken(),
            state.channelId,
            renderLine(line.text),
            persona.username,
            persona.icon,
          );
        } catch (error) {
          logger.warn('Incident Lab persona line failed', { runRef: run.runRef, error: error.message });
        }
        if (line.action) {
          try {
            await api.activatePhase(line.action === 'mitigate' ? 'mitigated' : line.action);
          } catch (error) {
            logger.warn('Incident Lab script action failed', { action: line.action, error: error.message });
          }
        }
      }, line.atMs - (Date.now() - run.declaredAt));
    }
    logger.info('Incident Lab persona script scheduled', {
      runRef: run.runRef,
      channel: state.channelName,
      lines: run.scenario.script.length,
    });
  }

  async function pollResponder(run) {
    if (!state || state.stopped) return;
    try {
      const messages = await api.history(slackToken(), state.channelId, {
        oldest: state.lastSeenTs,
        limit: 30,
      });
      // conversations.history returns newest first; walk oldest→newest.
      const fresh = messages
        .filter((m) => m.ts !== state.lastSeenTs)
        .reverse()
        // Our own persona posts carry a bot_profile; human/Devin app posts do
        // not come from this bot. Skip our posts, joins, and system messages.
        .filter((m) => m.type === 'message' && !m.subtype && m.text && !m.bot_profile);
      if (messages.length) {
        state.lastSeenTs = messages[0].ts;
      }
      if (!fresh.length || state.replies >= state.maxReplies) return;

      const transcript = fresh
        .map((m) => `investigator: ${m.text}`)
        .join('\n')
        .slice(-4000);
      const elapsedMs = Date.now() - run.declaredAt;
      const reply = await api.draft(run.scenario, elapsedMs, transcript);
      if (!reply) return;
      state.replies++;
      const [minDelay, maxDelay] = (run.scenario.llm && run.scenario.llm.replyDelayMs) || [15000, 60000];
      addTimer(async () => {
        if (!state || state.stopped) return;
        try {
          await api.post(slackToken(), state.channelId, reply.text, reply.persona.username, reply.persona.icon);
        } catch (error) {
          logger.warn('Incident Lab responder post failed', { error: error.message });
        }
      }, minDelay + Math.random() * (maxDelay - minDelay));
    } catch (error) {
      logger.warn('Incident Lab responder poll failed', { error: error.message });
    }
  }

  return {
    name: 'slack-personas',

    async onDeclare(run) {
      const token = slackToken();
      if (!token) {
        logger.warn('Incident Lab: SLACK_BOT_TOKEN not configured — persona layer disabled');
        return;
      }
      if (!run.incident || run.incident.publicId == null) {
        logger.warn('Incident Lab: no Datadog incident public id — persona layer disabled', {
          runRef: run.runRef,
        });
        return;
      }
      state = { stopped: false, timers: [], replies: 0, maxReplies: (run.scenario.llm && run.scenario.llm.maxRepliesPerRun) || 40 };
      const marker = `incident-${run.incident.publicId}-`;
      const maxAttempts = Math.max(12, Math.floor(run.scenario.durationMs / 4 / CHANNEL_LOOKUP_INTERVAL_MS));
      let attempts = 0;

      const locate = async () => {
        if (!state || state.stopped) return;
        attempts++;
        let channel = null;
        try {
          channel = await api.findChannel(token, marker);
        } catch (error) {
          logger.warn('Incident Lab channel lookup failed', { runRef: run.runRef, error: error.message });
        }
        if (!state || state.stopped) return;
        if (!channel) {
          if (attempts >= maxAttempts) {
            logger.warn('Incident Lab: incident channel never appeared', { runRef: run.runRef, marker });
            state.stopped = true;
            return;
          }
          addTimer(locate, CHANNEL_LOOKUP_INTERVAL_MS);
          return;
        }
        try {
          await api.join(token, channel.id);
        } catch (error) {
          logger.warn('Incident Lab: could not join incident channel', {
            runRef: run.runRef,
            channel: channel.name,
            error: error.message,
          });
        }
        state.channelId = channel.id;
        state.channelName = channel.name;
        state.lastSeenTs = undefined;
        scheduleScript(run);
        if (process.env.OPENAI_API_KEY) {
          state.responderInterval = setInterval(() => pollResponder(run), RESPONDER_POLL_MS);
          if (state.responderInterval.unref) state.responderInterval.unref();
        } else {
          logger.info('Incident Lab: OPENAI_API_KEY not set — dynamic responder disabled');
        }
      };
      addTimer(locate, CHANNEL_LOOKUP_INTERVAL_MS);
    },

    async onStop() {
      if (!state) return;
      state.stopped = true;
      for (const timer of state.timers) clearTimeout(timer);
      if (state.responderInterval) clearInterval(state.responderInterval);
      state = null;
    },
  };
}

module.exports = {
  createSlackPersonaSink,
  buildResponderPrompt,
  unlockedFacts,
  lockedFacts,
  renderLine,
};
