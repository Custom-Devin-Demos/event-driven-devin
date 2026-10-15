'use strict';

// Slack app: Field CTO reservations for #exec-field-requests.
//
//   POST /slack/fcto/commands      slash command `/fcto`
//   POST /slack/fcto/interactions  buttons + modal submissions
//   POST /slack/fcto/events        app_home_opened, url_verification
//   GET  /slack/fcto/health        config sanity check (no secrets)
//
// Every Slack request is verified with FCTO_SLACK_SIGNING_SECRET. State lives
// in data/fcto-reservations.json (see services/fcto/store.js).

const crypto = require('crypto');
const express = require('express');
const logger = require('../telemetry/logger');
const { getRoster, getAdminIds, findMember } = require('../../config/fcto-roster');
const { ReservationStore } = require('../services/fcto/store');
const R = require('../services/fcto/reservations');
const B = require('../services/fcto/blocks');
const slack = require('../services/fcto/slack-client');
const { buildIcs, icsFilename } = require('../services/fcto/ics');

const router = express.Router();
const store = new ReservationStore();

const SIGNATURE_WINDOW_SECONDS = 5 * 60;

function rawBodySaver(req, _res, buf) {
  req.rawBody = buf;
}

function requestChannel(fallback) {
  return fallback || process.env.FCTO_CHANNEL_ID || process.env.SLACK_CHANNEL_ID || '';
}

// ─── Signature verification ─────────────────────────────────────────────────

function verifySlackSignature(req, res, next) {
  const secret = process.env.FCTO_SLACK_SIGNING_SECRET;
  if (!secret) {
    if (process.env.FCTO_ALLOW_UNSIGNED === '1') return next();
    logger.warn('fcto: FCTO_SLACK_SIGNING_SECRET not set; rejecting Slack request');
    return res.status(503).send('Field CTO app is not configured');
  }
  const ts = Number(req.get('X-Slack-Request-Timestamp'));
  const signature = req.get('X-Slack-Signature') || '';
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > SIGNATURE_WINDOW_SECONDS) {
    return res.status(401).send('stale request');
  }
  const base = `v0:${ts}:${req.rawBody ? req.rawBody.toString('utf8') : ''}`;
  const expected = `v0=${crypto.createHmac('sha256', secret).update(base).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).send('bad signature');
  }
  return next();
}

// ─── Shared side effects ────────────────────────────────────────────────────

async function refreshCard(reservation) {
  const conflicts = reservation.status === R.STATUS.PENDING && reservation.assigneeKey
    ? R.findConflicts(store, reservation.assigneeKey, reservation.startTs, reservation.endTs, reservation.id)
    : [];
  const blocks = B.requestCard(reservation, { conflicts });
  const text = B.cardText(reservation);
  if (reservation.channelId && reservation.messageTs) {
    return slack.updateMessage(reservation.channelId, reservation.messageTs, text, blocks);
  }
  return null;
}

async function announce(reservation, previousStatus) {
  if (!reservation.channelId || !reservation.messageTs) return;
  if (reservation.status === previousStatus && reservation.status !== R.STATUS.APPROVED) return;
  const note = B.threadNote(reservation);
  await slack.postMessage(reservation.channelId, note, undefined, { thread_ts: reservation.messageTs });
  if (reservation.status === R.STATUS.APPROVED) {
    const assignee = findMember(reservation.assigneeKey);
    await slack.uploadFile({
      channel: reservation.channelId,
      threadTs: reservation.messageTs,
      filename: icsFilename(reservation),
      title: `Calendar block — ${assignee ? assignee.name : 'Field CTO'} / ${reservation.account}`,
      content: buildIcs(reservation, { host: process.env.FCTO_ICS_HOST || 'devindemos.com' }),
    });
  }
}

async function applyChange(reservation, previousStatus) {
  try {
    await refreshCard(reservation);
    await announce(reservation, previousStatus);
  } catch (err) {
    logger.error('fcto: failed to update Slack after change', { id: reservation.id, error: err.message });
  }
}

async function publishHome(userId) {
  try {
    await slack.publishHome(userId, B.homeView(store, userId));
  } catch (err) {
    logger.warn('fcto: views.publish failed', { error: err.message });
  }
}

async function tellUser(payload, text) {
  const channel = payload.channel && payload.channel.id;
  const user = payload.user && payload.user.id;
  if (payload.response_url) {
    return slack.respond(payload.response_url, { response_type: 'ephemeral', replace_original: false, text });
  }
  if (channel && user) return slack.postEphemeral(channel, user, text);
  return null;
}

async function postNewRequest(reservation) {
  const channel = requestChannel(reservation.channelId);
  if (!channel) {
    logger.error('fcto: no channel configured for request card', { id: reservation.id });
    return null;
  }
  const conflicts = reservation.assigneeKey
    ? R.findConflicts(store, reservation.assigneeKey, reservation.startTs, reservation.endTs, reservation.id)
    : [];
  const posted = await slack.postMessage(channel, B.cardText(reservation), B.requestCard(reservation, { conflicts }));
  if (posted && posted.ok) {
    return R.setMessage(store, reservation.id, posted.channel || channel, posted.ts);
  }
  return null;
}

// ─── Slash command ──────────────────────────────────────────────────────────

function parseWindow(args, now = Math.floor(Date.now() / 1000)) {
  const day = 86400;
  const start = new Date(now * 1000);
  start.setUTCHours(0, 0, 0, 0);
  const dow = (start.getUTCDay() + 6) % 7; // Monday = 0
  const monday = Math.floor(start.getTime() / 1000) - dow * day;
  const word = (args[0] || '').toLowerCase();
  if (word === 'next') return { from: monday + 7 * day, to: monday + 14 * day, title: 'Field CTO schedule — next week' };
  if (word === 'month') return { from: now, to: now + 31 * day, title: 'Field CTO schedule — next 31 days' };
  if (word === 'all') return { from: now, to: undefined, title: 'Field CTO schedule — everything upcoming' };
  return { from: Math.min(now, monday), to: monday + 7 * day, title: 'Field CTO schedule — this week' };
}

function resolvePersonArg(arg) {
  if (!arg) return null;
  const m = arg.match(/^<@([A-Z0-9]+)(?:\|[^>]*)?>$/i) || arg.match(/^@?([A-Z0-9]{9,})$/i);
  if (m) return findMember(m[1]);
  const needle = arg.replace(/^@/, '').toLowerCase();
  return getRoster().find((r) => r.name.toLowerCase().includes(needle) || r.key.toLowerCase().includes(needle)) || null;
}

async function handleCommand(body) {
  const text = (body.text || '').trim();
  const [sub = '', ...args] = text.split(/\s+/).filter(Boolean);
  const userId = body.user_id;

  switch (sub.toLowerCase()) {
    case '':
    case 'request':
    case 'new': {
      const result = await slack.openView(body.trigger_id, B.requestModal({ channelId: requestChannel(body.channel_id) }));
      if (result && result.ok) return null;
      return { response_type: 'ephemeral', text: `Couldn't open the request form (${result ? result.error : 'unknown error'}).` };
    }
    case 'schedule':
    case 'who':
    case 'list': {
      if (args[0] && args[0].toLowerCase() === 'me') {
        const mine = R.listReservations(store, { requesterId: userId, from: Math.floor(Date.now() / 1000) - 86400 });
        const lines = mine.map((r) => `• ${r.id} · ${r.account} · ${R.describeWho(r)} · ${R.slackRange(r.startTs, r.endTs)} · ${B.STATUS_META[r.status].label}`);
        return { response_type: 'ephemeral', text: lines.length ? `*Your requests*\n${lines.join('\n')}` : 'You have no open requests. `/fcto request` to make one.' };
      }
      const person = resolvePersonArg(args[0]);
      const windowArgs = person ? args.slice(1) : args;
      const window = parseWindow(windowArgs);
      if (person) {
        const w = windowArgs.length ? window : { from: Math.floor(Date.now() / 1000), to: undefined };
        return {
          response_type: 'ephemeral',
          text: `${person.name}'s schedule`,
          blocks: B.scheduleBlocks(store, { ...w, title: `${person.name} — upcoming reservations`, memberKey: person.key, viewerId: userId }),
        };
      }
      if (args[0] && !person && !/^(next|month|all|week|this)$/i.test(args[0])) {
        return { response_type: 'ephemeral', text: `I don't know a Field CTO called "${args[0]}". Try \`/fcto roster\`.` };
      }
      return { response_type: 'ephemeral', text: window.title, blocks: B.scheduleBlocks(store, { ...window, viewerId: userId }) };
    }
    case 'roster':
      return { response_type: 'ephemeral', text: 'Field CTO roster', blocks: B.rosterBlocks() };
    case 'help':
    default:
      return { response_type: 'ephemeral', text: B.helpText() };
  }
}

// ─── Interactions ───────────────────────────────────────────────────────────

async function handleBlockAction(payload) {
  const action = (payload.actions || [])[0];
  if (!action) return;
  const userId = payload.user.id;
  const triggerId = payload.trigger_id;
  const id = action.value;

  if (action.action_id === B.ACTION.NEW_REQUEST) {
    const channelId = payload.channel && payload.channel.id && !String(payload.channel.id).startsWith('D') ? payload.channel.id : requestChannel();
    await slack.openView(triggerId, B.requestModal({ channelId }));
    return;
  }
  if (action.action_id === B.ACTION.REFRESH_HOME) {
    await publishHome(userId);
    return;
  }
  if (action.action_id === B.ACTION.NOOP) return;

  const current = store.get(id);
  if (!current) {
    await tellUser(payload, `I can't find request ${id} any more.`);
    return;
  }
  const previousStatus = current.status;

  try {
    switch (action.action_id) {
      case B.ACTION.APPROVE: {
        if (!R.canDecide(current, userId)) throw new R.ReservationError('forbidden', 'Only an admin or the requested Field CTO can approve this request.');
        try {
          const updated = await R.approve(store, id, { by: userId });
          await applyChange(updated, previousStatus);
        } catch (err) {
          if (err.code === 'conflict' || err.code === 'assignee_required') {
            await slack.openView(triggerId, B.assignModal(store, current, {
              mode: 'approve',
              preselectKey: current.assigneeKey,
              warning: err.code === 'conflict' ? `${err.message} Tick "Book anyway" to double-book, or pick someone else.` : null,
            }));
            return;
          }
          throw err;
        }
        break;
      }
      case B.ACTION.CLAIM: {
        if (!R.canClaim(current, userId)) throw new R.ReservationError('forbidden', 'Only a Field CTO can claim an open request. Admins: use Assign.');
        try {
          const updated = await R.claim(store, id, { by: userId });
          await applyChange(updated, previousStatus);
        } catch (err) {
          if (err.code === 'conflict') {
            const me = R.memberBySlackId(userId);
            await slack.openView(triggerId, B.assignModal(store, current, {
              mode: 'claim',
              preselectKey: me.key,
              warning: `${err.message} Tick "Book anyway" to take it regardless.`,
            }));
            return;
          }
          throw err;
        }
        break;
      }
      case B.ACTION.ASSIGN: {
        if (!R.canReassign(current, userId)) throw new R.ReservationError('forbidden', 'Only an admin can assign or reassign a request.');
        const mode = current.status === R.STATUS.PENDING && current.requestType === 'any' ? 'assign' : 'reassign';
        await slack.openView(triggerId, B.assignModal(store, current, { mode, preselectKey: current.assigneeKey }));
        return;
      }
      case B.ACTION.DECLINE: {
        if (!R.canDecide(current, userId)) throw new R.ReservationError('forbidden', 'Only an admin or the requested Field CTO can decline this request.');
        if (current.status !== R.STATUS.PENDING) throw new R.ReservationError('not_pending', `${id} is already ${current.status}.`);
        await slack.openView(triggerId, B.declineModal(current));
        return;
      }
      case B.ACTION.CANCEL: {
        const updated = await R.cancel(store, id, { by: userId });
        await applyChange(updated, previousStatus);
        break;
      }
      default:
        return;
    }
  } catch (err) {
    if (err instanceof R.ReservationError) {
      await tellUser(payload, `:no_entry: ${err.message}`);
      return;
    }
    logger.error('fcto: block action failed', { action: action.action_id, id, error: err.message });
    await tellUser(payload, 'Something went wrong handling that action.');
  }
}

// Returns the JSON body Slack expects for view_submission (or null for a
// plain 200). Slack-side effects are run after the response is sent.
async function handleViewSubmission(payload, after) {
  const view = payload.view;
  const userId = payload.user.id;

  if (view.callback_id === B.CALLBACK.REQUEST) {
    const input = { ...B.readRequestModal(view), requesterId: userId };
    try {
      const reservation = await R.createRequest(store, input);
      after(async () => {
        const stored = await postNewRequest(reservation);
        if (!stored) {
          const dm = await slack.openDm(userId);
          if (dm && dm.ok) await slack.postMessage(dm.channel.id, `Your request ${reservation.id} was saved but I couldn't post it to the channel. Ask an admin to check FCTO_CHANNEL_ID.`);
        }
        await publishHome(userId);
      });
      return null;
    } catch (err) {
      if (err instanceof R.ReservationError) {
        return B.modalErrors(err) || { response_action: 'errors', errors: { account: err.message } };
      }
      throw err;
    }
  }

  if (view.callback_id === B.CALLBACK.DECLINE) {
    const { id, reason } = B.readDeclineModal(view);
    const current = store.get(id);
    try {
      const updated = await R.decline(store, id, { by: userId, reason });
      after(() => applyChange(updated, current ? current.status : null));
      return null;
    } catch (err) {
      if (err instanceof R.ReservationError) return { response_action: 'errors', errors: { reason: err.message } };
      throw err;
    }
  }

  if (view.callback_id === B.CALLBACK.ASSIGN) {
    const { id, mode, assigneeKey, force } = B.readAssignModal(view);
    const current = store.get(id);
    if (!current) return { response_action: 'errors', errors: { assignee: `Request ${id} no longer exists.` } };
    try {
      let updated;
      const me = R.memberBySlackId(userId);
      if (mode === 'reassign' || (current.status !== R.STATUS.PENDING)) {
        updated = await R.reassign(store, id, { by: userId, assigneeKey, force });
      } else if (!R.isAdmin(userId) && me && me.key === assigneeKey && R.canClaim(current, userId)) {
        updated = await R.claim(store, id, { by: userId, force });
      } else {
        updated = await R.approve(store, id, { by: userId, assigneeKey, force });
      }
      after(() => applyChange(updated, current.status));
      return null;
    } catch (err) {
      if (err instanceof R.ReservationError) {
        const field = err.code === 'conflict' ? 'force' : 'assignee';
        return { response_action: 'errors', errors: { [field]: err.message } };
      }
      throw err;
    }
  }

  return null;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

const formParser = express.urlencoded({ extended: false, limit: '1mb', verify: rawBodySaver });
const jsonParser = express.json({ limit: '1mb', verify: rawBodySaver });

router.post('/slack/fcto/commands', formParser, verifySlackSignature, async (req, res) => {
  try {
    const reply = await handleCommand(req.body || {});
    if (reply) return res.json(reply);
    return res.status(200).send('');
  } catch (err) {
    logger.error('fcto: slash command failed', { error: err.message });
    return res.json({ response_type: 'ephemeral', text: 'Something went wrong. Try again in a moment.' });
  }
});

router.post('/slack/fcto/interactions', formParser, verifySlackSignature, async (req, res) => {
  let payload;
  try {
    payload = JSON.parse(req.body.payload);
  } catch {
    return res.status(400).send('bad payload');
  }

  if (payload.type === 'block_actions') {
    res.status(200).send('');
    handleBlockAction(payload).catch((err) => logger.error('fcto: block_actions handler crashed', { error: err.message }));
    return null;
  }

  if (payload.type === 'view_submission') {
    const deferred = [];
    try {
      const body = await handleViewSubmission(payload, (fn) => deferred.push(fn));
      if (body) res.json(body);
      else res.status(200).send('');
    } catch (err) {
      logger.error('fcto: view_submission failed', { callback: payload.view && payload.view.callback_id, error: err.message });
      res.json({ response_action: 'errors', errors: { account: 'Something went wrong saving this. Try again.' } });
    }
    for (const fn of deferred) {
      await Promise.resolve().then(fn).catch((err) => logger.error('fcto: deferred view effect failed', { error: err.message }));
    }
    return null;
  }

  return res.status(200).send('');
});

router.post('/slack/fcto/events', jsonParser, verifySlackSignature, async (req, res) => {
  const body = req.body || {};
  if (body.type === 'url_verification') return res.json({ challenge: body.challenge });
  res.status(200).send('');
  const event = body.event || {};
  if (body.type === 'event_callback' && event.type === 'app_home_opened' && event.tab === 'home' && event.user) {
    await publishHome(event.user);
  }
  return null;
});

router.get('/slack/fcto/health', (_req, res) => {
  const roster = getRoster();
  res.json({
    ok: true,
    signingSecretConfigured: Boolean(process.env.FCTO_SLACK_SIGNING_SECRET),
    botTokenConfigured: Boolean(slack.botToken()),
    channelConfigured: Boolean(requestChannel()),
    admins: getAdminIds().length,
    roster: roster.map((m) => ({ name: m.name, region: m.region, tz: m.tz, slackIdConfigured: Boolean(m.slackId) })),
    reservations: store.all().length,
    storeFile: store.file,
  });
});

module.exports = router;
module.exports._internal = { store, handleCommand, handleBlockAction, handleViewSubmission, parseWindow, resolvePersonArg, verifySlackSignature };
