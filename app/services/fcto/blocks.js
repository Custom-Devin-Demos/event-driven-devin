'use strict';

// Block Kit builders for the Field CTO reservation app.

const { getRoster, findMember, REGION_LABELS, getAdminIds } = require('../../../config/fcto-roster');
const R = require('./reservations');
const Q = require('../../../config/fcto-qualifications');

const CALLBACK = Object.freeze({
  REQUEST: 'fcto_request_submit',
  DECLINE: 'fcto_decline_submit',
  ASSIGN: 'fcto_assign_submit',
});

const ACTION = Object.freeze({
  NEW_REQUEST: 'fcto_new_request',
  APPROVE: 'fcto_approve',
  DECLINE: 'fcto_decline',
  CLAIM: 'fcto_claim',
  ASSIGN: 'fcto_assign',
  CANCEL: 'fcto_cancel',
  REFRESH_HOME: 'fcto_refresh_home',
  NOOP: 'fcto_noop',
});

const STATUS_META = {
  [R.STATUS.PENDING]: { emoji: ':hourglass_flowing_sand:', label: 'Pending' },
  [R.STATUS.APPROVED]: { emoji: ':white_check_mark:', label: 'Approved' },
  [R.STATUS.DECLINED]: { emoji: ':no_entry_sign:', label: 'Declined' },
  [R.STATUS.CANCELLED]: { emoji: ':wastebasket:', label: 'Cancelled' },
};

const REGION_ZONES = { US: 'America/Los_Angeles', EU: 'Europe/Berlin', JP: 'Asia/Tokyo' };

function plain(text, emoji = true) {
  return { type: 'plain_text', text: String(text).slice(0, 150), emoji };
}

// User-entered text goes through esc() so it can't carry mrkdwn control
// sequences (<@U…> mentions, <!channel>, links) into app-authored cards.
function esc(text) {
  return String(text == null ? '' : text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function mrkdwn(text) {
  return { type: 'mrkdwn', text: String(text).slice(0, 3000) };
}

function section(text, extra = {}) {
  return { type: 'section', text: mrkdwn(text), ...extra };
}

function context(...texts) {
  return { type: 'context', elements: texts.filter(Boolean).map(mrkdwn).slice(0, 10) };
}

function mention(member) {
  if (!member) return '_unassigned_';
  return member.slackId ? `<@${member.slackId}> (${member.name})` : `*${member.name}*`;
}

function memberLabel(member) {
  const zone = R.formatInTz(Math.floor(Date.now() / 1000), member.tz).zone;
  return `${member.name} — ${REGION_LABELS[member.region] || member.region} (${zone})`;
}

function whoOptions(env = process.env) {
  const members = getRoster(env).map((m) => ({ text: plain(memberLabel(m)), value: `MEMBER:${m.key}` }));
  const any = Object.entries(R.PREFERENCES).map(([key, label]) => ({ text: plain(label), value: `ANY:${key}` }));
  return [
    { label: plain('Any available Field CTO'), options: any },
    { label: plain('A specific Field CTO'), options: members },
  ];
}

function durationOptions() {
  return Object.entries(R.DURATIONS).map(([key, d]) => ({ text: plain(d.label), value: key }));
}

// ─── Request modal ──────────────────────────────────────────────────────────

const qualOptions = (list) => list.map((x) => ({ text: plain(x.label), value: x.key }));

function qualSelect(blockId, label, list, placeholder) {
  return {
    type: 'input',
    block_id: blockId,
    dispatch_action: true,
    label: plain(label),
    element: { type: 'static_select', action_id: 'value', placeholder: plain(placeholder), options: qualOptions(list) },
  };
}

// The "who" block id carries the suggestion so Slack re-applies initial_option
// when the suggestion changes but keeps a manual pick while it stays the same.
const whoBlockId = (suggestion) => (suggestion ? `who_${suggestion.who.replace(/[^A-Za-z0-9]/g, '_')}` : 'who');

function findWhoOption(value) {
  for (const group of whoOptions()) {
    const hit = group.options.find((o) => o.value === value);
    if (hit) return hit;
  }
  return null;
}

// `audience`/`suggestion` come from the requester's current picks (see
// routes/fcto.js): a "Below" warning and a pre-selected Field CTO.
function requestModal({ channelId, defaultStartTs, audience, suggestion } = {}) {
  const start = defaultStartTs || (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(17, 0, 0, 0); // 10am PT / 7pm CET-ish default
    return Math.floor(d.getTime() / 1000);
  })();
  return {
    type: 'modal',
    callback_id: CALLBACK.REQUEST,
    private_metadata: JSON.stringify({ channelId: channelId || null }),
    title: plain('Reserve a Field CTO'),
    submit: plain('Submit request'),
    close: plain('Cancel'),
    blocks: [
      {
        type: 'input',
        block_id: 'account',
        label: plain('Account / customer'),
        element: { type: 'plain_text_input', action_id: 'value', max_length: 120, placeholder: plain('e.g. Acme Corp — EBC') },
      },
      {
        type: 'input',
        block_id: 'purpose',
        label: plain('What do you need them for?'),
        element: { type: 'plain_text_input', action_id: 'value', multiline: true, max_length: 500, placeholder: plain('Executive briefing, architecture review, onsite, QBR…') },
      },
      qualSelect('audience', 'Audience', Q.AUDIENCES, 'Most senior customer attendee'),
      ...(Q.AUDIENCE[audience] && !Q.AUDIENCE[audience].eligible ? [context(`:no_entry: ${Q.BELOW_MESSAGE}`)] : []),
      qualSelect('country', 'Country', Q.COUNTRIES, 'Where the customer is'),
      qualSelect('industry', 'Industry', Q.INDUSTRIES, 'Customer industry'),
      (() => {
        const initial = suggestion && findWhoOption(suggestion.who);
        return {
          type: 'input',
          block_id: whoBlockId(initial ? suggestion : null),
          label: plain('Who do you need?'),
          ...(initial ? { hint: plain(`Suggested for ${suggestion.reason}. You can pick someone else.`) } : {}),
          element: {
            type: 'static_select',
            action_id: 'value',
            placeholder: plain('Pick a Field CTO or "any"'),
            option_groups: whoOptions(),
            ...(initial ? { initial_option: initial } : {}),
          },
        };
      })(),
      {
        type: 'input',
        block_id: 'start',
        label: plain('Start'),
        hint: plain('Shown in your Slack time zone. Field CTOs see it in theirs.'),
        element: { type: 'datetimepicker', action_id: 'value', initial_date_time: start },
      },
      {
        type: 'input',
        block_id: 'duration',
        label: plain('Duration'),
        element: {
          type: 'static_select',
          action_id: 'value',
          options: durationOptions(),
          initial_option: { text: plain(R.DURATIONS['1h'].label), value: '1h' },
        },
      },
      {
        type: 'input',
        block_id: 'end',
        optional: true,
        label: plain('End (only for "Custom end time")'),
        hint: plain('Use this for multi-day blocks like an onsite or a conference.'),
        element: { type: 'datetimepicker', action_id: 'value' },
      },
      {
        type: 'input',
        block_id: 'meetingLink',
        optional: true,
        label: plain('Meeting link'),
        element: { type: 'url_text_input', action_id: 'value', placeholder: plain('https://…') },
      },
      {
        type: 'input',
        block_id: 'notes',
        optional: true,
        label: plain('Notes for the Field CTO'),
        element: { type: 'plain_text_input', action_id: 'value', multiline: true, max_length: 500 },
      },
    ],
  };
}

// Pull the submitted values out of a view_submission payload.
function readRequestModal(view) {
  const v = view.state.values;
  const pick = (block) => (v[block] && v[block].value) || {};
  const meta = (() => { try { return JSON.parse(view.private_metadata || '{}'); } catch { return {}; } })();
  return {
    account: pick('account').value,
    purpose: pick('purpose').value,
    audience: (pick('audience').selected_option || {}).value,
    country: (pick('country').selected_option || {}).value,
    industry: (pick('industry').selected_option || {}).value,
    who: (pick(Object.keys(v).find((k) => k === 'who' || k.startsWith('who_')) || 'who').selected_option || {}).value,
    startTs: pick('start').selected_date_time,
    durationKey: (pick('duration').selected_option || {}).value,
    endTs: pick('end').selected_date_time,
    meetingLink: pick('meetingLink').value,
    notes: pick('notes').value,
    channelId: meta.channelId,
  };
}

// Map a ReservationError.field to the modal block id for an inline error.
function modalErrors(err, view) {
  let field = err && err.field;
  if (!field) return null;
  const values = (view && view.state && view.state.values) || {};
  if (field === 'who') field = Object.keys(values).find((k) => k === 'who' || k.startsWith('who_')) || field;
  return { response_action: 'errors', errors: { [field]: err.message } };
}

// ─── Decline / assign modals ────────────────────────────────────────────────

function declineModal(reservation) {
  return {
    type: 'modal',
    callback_id: CALLBACK.DECLINE,
    private_metadata: JSON.stringify({ id: reservation.id }),
    title: plain(`Decline ${reservation.id}`),
    submit: plain('Decline request'),
    close: plain('Back'),
    blocks: [
      section(`*${esc(reservation.account)}* · ${R.describeWho(reservation)}\n${R.slackRange(reservation.startTs, reservation.endTs)}`),
      {
        type: 'input',
        block_id: 'reason',
        optional: true,
        label: plain('Reason (shared with the requester)'),
        element: { type: 'plain_text_input', action_id: 'value', multiline: true, max_length: 500 },
      },
    ],
  };
}

// Used for "Assign" on open requests, "Reassign" on anything, and as the
// conflict-override confirmation when an approve/claim collides.
function assignModal(store, reservation, { mode = 'assign', preselectKey = null, warning = null } = {}) {
  const candidates = R.suggestAssignees(store, reservation);
  const options = candidates.map((m) => ({
    text: plain(`${m.conflicts.length ? ':warning: ' : ''}${memberLabel(m)}${m.recommended ? ' · recommended' : ''}${m.preferred || m.recommended ? '' : ' · other region'}`),
    value: m.key,
  }));
  const recommended = candidates.find((m) => m.recommended && !m.conflicts.length);
  const initialKey = preselectKey || (recommended ? recommended.key : null);
  const initial = initialKey ? options.find((o) => o.value === initialKey) : null;
  const titles = { assign: 'Assign a Field CTO', reassign: `Reassign ${reservation.id}`, approve: `Approve ${reservation.id}`, claim: `Claim ${reservation.id}` };
  const blocks = [
    section(`*${esc(reservation.account)}* — ${esc(reservation.purpose)}\n${R.slackRange(reservation.startTs, reservation.endTs)} · ${R.durationLabel(reservation)}\nRequested: ${R.describeWho(reservation)}`),
  ];
  if (warning) blocks.push(section(`:warning: ${warning}`));
  const busy = candidates.filter((m) => m.conflicts.length);
  if (busy.length) {
    blocks.push(context(`Already reserved in this window: ${busy.map((m) => `${m.name} (${m.conflicts.map((c) => c.id).join(', ')})`).join(' · ')}`));
  }
  blocks.push({
    type: 'input',
    block_id: 'assignee',
    label: plain('Field CTO'),
    element: {
      type: 'static_select',
      action_id: 'value',
      placeholder: plain('Pick a Field CTO'),
      options,
      ...(initial ? { initial_option: initial } : {}),
    },
  });
  blocks.push({
    type: 'input',
    block_id: 'force',
    optional: true,
    label: plain('Conflicts'),
    element: {
      type: 'checkboxes',
      action_id: 'value',
      options: [{ text: plain('Book anyway, even if this Field CTO is already reserved'), value: 'force' }],
    },
  });
  return {
    type: 'modal',
    callback_id: CALLBACK.ASSIGN,
    private_metadata: JSON.stringify({ id: reservation.id, mode }),
    title: plain(titles[mode] || titles.assign),
    submit: plain(mode === 'reassign' ? 'Reassign' : 'Approve'),
    close: plain('Back'),
    blocks,
  };
}

function readAssignModal(view) {
  const v = view.state.values;
  const meta = (() => { try { return JSON.parse(view.private_metadata || '{}'); } catch { return {}; } })();
  const assignee = ((v.assignee || {}).value || {}).selected_option;
  const forceOpts = ((v.force || {}).value || {}).selected_options || [];
  return { id: meta.id, mode: meta.mode, assigneeKey: assignee ? assignee.value : null, force: forceOpts.some((o) => o.value === 'force') };
}

function readDeclineModal(view) {
  const v = view.state.values;
  const meta = (() => { try { return JSON.parse(view.private_metadata || '{}'); } catch { return {}; } })();
  return { id: meta.id, reason: ((v.reason || {}).value || {}).value || '' };
}

// ─── Request card ───────────────────────────────────────────────────────────

function localTimesLine(reservation) {
  const member = findMember(reservation.assigneeKey || reservation.requestedKey);
  if (member) {
    return `*${member.name}'s local time:* ${R.formatRangeInTz(reservation.startTs, reservation.endTs, member.tz)}`;
  }
  const regions = reservation.preference && reservation.preference !== 'ANY' ? [reservation.preference] : ['US', 'EU', 'JP'];
  return regions.map((r) => `*${REGION_LABELS[r]}:* ${R.formatRangeInTz(reservation.startTs, reservation.endTs, REGION_ZONES[r])}`).join('\n');
}

function statusLine(reservation) {
  const meta = STATUS_META[reservation.status];
  const assignee = findMember(reservation.assigneeKey);
  switch (reservation.status) {
    case R.STATUS.APPROVED:
      return `${meta.emoji} *Approved* — ${mention(assignee)} is reserved${reservation.decidedBy ? ` · approved by <@${reservation.decidedBy}>` : ''}`;
    case R.STATUS.DECLINED:
      return `${meta.emoji} *Declined*${reservation.decidedBy ? ` by <@${reservation.decidedBy}>` : ''}${reservation.declineReason ? ` — ${esc(reservation.declineReason)}` : ''}`;
    case R.STATUS.CANCELLED:
      return `${meta.emoji} *Cancelled*`;
    default:
      return reservation.requestType === 'any'
        ? `${meta.emoji} *Pending* — open to any Field CTO${reservation.preference && reservation.preference !== 'ANY' ? ` (${REGION_LABELS[reservation.preference]} hours preferred)` : ''}. Field CTOs can *Claim*; admins can *Assign*.`
        : `${meta.emoji} *Pending* — waiting on ${mention(assignee)} or an admin`;
  }
}

function cardActions(reservation, conflicts) {
  if (reservation.status === R.STATUS.DECLINED || reservation.status === R.STATUS.CANCELLED) return null;
  const btn = (text, actionId, style, confirm) => ({
    type: 'button',
    text: plain(text),
    action_id: actionId,
    value: reservation.id,
    ...(style ? { style } : {}),
    ...(confirm ? { confirm } : {}),
  });
  const elements = [];
  if (reservation.status === R.STATUS.PENDING) {
    if (reservation.requestType === 'specific') {
      elements.push(btn(conflicts.length ? 'Approve (conflict)' : 'Approve', ACTION.APPROVE, conflicts.length ? undefined : 'primary'));
    } else {
      elements.push(btn('Claim', ACTION.CLAIM, 'primary'));
      elements.push(btn('Assign…', ACTION.ASSIGN));
    }
    elements.push(btn('Decline', ACTION.DECLINE, 'danger'));
    if (reservation.requestType === 'specific') elements.push(btn('Reassign…', ACTION.ASSIGN));
  } else {
    elements.push(btn('Reassign…', ACTION.ASSIGN));
  }
  elements.push(btn('Cancel request', ACTION.CANCEL, undefined, {
    title: plain('Cancel this request?'),
    text: mrkdwn(`This releases ${reservation.id}. Only the requester or an admin can do this.`),
    confirm: plain('Yes, cancel it'),
    deny: plain('Keep it'),
  }));
  return { type: 'actions', block_id: `actions_${reservation.id}`, elements };
}

function requestCard(reservation, { conflicts = [] } = {}) {
  const meta = STATUS_META[reservation.status];
  const blocks = [
    { type: 'header', text: plain(`${meta.emoji} Field CTO request ${reservation.id} · ${meta.label}`) },
    {
      type: 'section',
      fields: [
        mrkdwn(`*Account*\n${esc(reservation.account)}`),
        mrkdwn(`*Requested by*\n<@${reservation.requesterId}>`),
        mrkdwn(`*Who*\n${R.describeWho(reservation)}`),
        mrkdwn(`*When*\n${R.slackRange(reservation.startTs, reservation.endTs)} · ${R.durationLabel(reservation)}`),
      ],
    },
    section(`*Purpose*\n${esc(reservation.purpose)}`),
  ];
  const qualifications = R.qualificationsLabel(reservation);
  if (qualifications) blocks.push(context(`*Audience · country · industry:* ${qualifications}`));
  if (reservation.notes) blocks.push(section(`*Notes*\n${esc(reservation.notes)}`));
  if (reservation.meetingLink) blocks.push(context(`:link: <${reservation.meetingLink}>`));
  blocks.push(context(localTimesLine(reservation)));
  if (conflicts.length && reservation.status === R.STATUS.PENDING) {
    blocks.push(context(`:warning: *Conflict:* ${conflicts.map((c) => `${c.id} (${c.account}, ${R.slackRange(c.startTs, c.endTs)})`).join('; ')}`));
  }
  blocks.push({ type: 'divider' });
  blocks.push(section(statusLine(reservation)));
  const actions = cardActions(reservation, conflicts);
  if (actions) blocks.push(actions);
  return blocks;
}

function cardText(reservation) {
  const member = findMember(reservation.assigneeKey || reservation.requestedKey);
  return `[${STATUS_META[reservation.status].label}] Field CTO request ${reservation.id}: ${esc(reservation.account)} — ${member ? member.name : R.describeWho(reservation)}, ${R.formatRangeInTz(reservation.startTs, reservation.endTs, 'UTC')}`;
}

function threadNote(reservation) {
  const assignee = findMember(reservation.assigneeKey);
  switch (reservation.status) {
    case R.STATUS.APPROVED:
      return `<@${reservation.requesterId}> ${mention(assignee)} is reserved for *${esc(reservation.account)}* — ${R.slackRange(reservation.startTs, reservation.endTs)}${assignee ? ` (${R.formatRangeInTz(reservation.startTs, reservation.endTs, assignee.tz)} for ${assignee.name.split(' ')[0]})` : ''}. Calendar invite attached below.`;
    case R.STATUS.DECLINED:
      return `<@${reservation.requesterId}> this request was declined${reservation.declineReason ? `: ${esc(reservation.declineReason)}` : '.'}`;
    case R.STATUS.CANCELLED:
      return `Request ${reservation.id} was cancelled.`;
    default:
      return `Request ${reservation.id} updated.`;
  }
}

// ─── Schedule & App Home ────────────────────────────────────────────────────

function dayKey(ts, tz) {
  return R.formatInTz(ts, tz).day;
}

function scheduleBlocks(store, { from, to, title, memberKey, tz = 'UTC', viewerId } = {}) {
  const items = R.listReservations(store, { from, to, memberKey });
  const blocks = [{ type: 'header', text: plain(title || 'Field CTO schedule') }];
  if (!items.length) {
    blocks.push(section('_Nothing on the books for this window._'));
    return blocks;
  }
  const byDay = new Map();
  items.forEach((r) => {
    const key = dayKey(r.startTs, tz);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(r);
  });
  byDay.forEach((list, day) => {
    const lines = list.map((r) => {
      const member = findMember(r.assigneeKey || r.requestedKey);
      const who = member ? `*${member.name}*` : `_${R.describeWho(r)}_`;
      const pending = r.status === R.STATUS.PENDING ? ' · :hourglass_flowing_sand: pending' : '';
      const mine = viewerId && r.requesterId === viewerId ? ' · _yours_' : '';
      const qual = R.qualificationsLabel(r);
      return `• ${R.slackRange(r.startTs, r.endTs)} — ${who} · ${esc(r.account)} (${r.id})${qual ? ` · ${qual}` : ''}${pending}${mine}`;
    });
    blocks.push(section(`*${day}*\n${lines.join('\n')}`));
  });
  blocks.push(context(`${items.length} reservation${items.length === 1 ? '' : 's'} · times shown in your Slack time zone · \`/fcto schedule\` for more`));
  return blocks.slice(0, 48);
}

const AVAIL_EMOJI = { free: ':large_green_circle:', partial: ':large_yellow_circle:', booked: ':red_circle:' };
const DAY_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
const dayLabel = (ts) => DAY_FMT.format(ts * 1000);

// `/fcto free <dates>`: one line per Field CTO, fully-free people first.
function availabilityBlocks(store, { from, to, title } = {}) {
  const { days, members } = R.availability(store, { from, to });
  if (!days.length) return [section('_No days in that range._')];
  const span = days.length === 1 ? dayLabel(days[0]) : `${dayLabel(days[0])} to ${dayLabel(days[days.length - 1])}`;
  const blocks = [{ type: 'header', text: plain(title || `Who's free — ${span}`) }];
  const sorted = members.slice().sort((a, b) => b.freeDays - a.freeDays || a.member.name.localeCompare(b.member.name));
  sorted.forEach(({ member, days: perDay, freeDays }) => {
    const region = REGION_LABELS[member.region] || member.region;
    if (freeDays === perDay.length) {
      blocks.push(section(`${AVAIL_EMOJI.free} *${member.name}* (${region}) — free ${perDay.length === 1 ? 'all day' : `all ${perDay.length} days`}`));
      return;
    }
    const detail = perDay.map((d) => {
      if (d.status === 'free') return `${AVAIL_EMOJI.free} ${dayLabel(d.day)}`;
      const what = d.busy.map((b) => (d.status === 'booked' ? b.id : `${R.formatRangeInTz(b.startTs, b.endTs, member.tz)} ${b.id}`)).join(', ');
      return `${AVAIL_EMOJI[d.status]} ${dayLabel(d.day)} (${what})`;
    });
    const bookedDays = perDay.filter((d) => d.status === 'booked').length;
    const head = bookedDays === perDay.length ? AVAIL_EMOJI.booked : AVAIL_EMOJI.partial;
    const summary = perDay.length === 1 ? (bookedDays ? 'booked' : 'partly booked') : `${freeDays}/${perDay.length} days free`;
    blocks.push(section(`${head} *${member.name}* (${region}) — ${summary}\n${detail.join(' · ')}`));
  });
  blocks.push(context(`${AVAIL_EMOJI.free} free · ${AVAIL_EMOJI.partial} partly booked · ${AVAIL_EMOJI.booked} booked (6h+) · each person's local day · approved reservations in this app only — not personal calendars · \`/fcto free oct 22-24\``));
  return blocks;
}

function rosterBlocks() {
  const now = Math.floor(Date.now() / 1000);
  const lines = getRoster().map((m) => {
    const t = R.formatInTz(now, m.tz);
    return `• ${mention(m)} — ${REGION_LABELS[m.region]} · now ${t.time} ${t.zone}${m.slackId ? '' : ' · _Slack handle not configured_'}`;
  });
  return [section(`*Field CTOs*\n${lines.join('\n')}`)];
}

function homeView(store, userId) {
  const now = Math.floor(Date.now() / 1000);
  const horizon = now + 21 * 86400;
  const upcoming = scheduleBlocks(store, { from: now, to: horizon, title: 'Next 3 weeks', viewerId: userId }).slice(1);
  const mine = R.listReservations(store, { from: now, requesterId: userId });
  const admin = R.isAdmin(userId);
  const member = R.memberBySlackId(userId);
  const blocks = [
    { type: 'header', text: plain(':calendar: Field CTO reservations') },
    section(`Request a block of a Field CTO's time for an account. Requests post to the channel where ${admin ? 'you and the other admins' : 'admins and the Field CTO'} approve them.${member ? `\nYou're on the roster as *${member.name}* — you can approve requests that name you and claim open ones.` : ''}${admin ? '\nYou are an *admin*: you can approve, decline, assign and reassign any request.' : ''}`),
    {
      type: 'actions',
      elements: [
        { type: 'button', text: plain(':heavy_plus_sign: New request'), style: 'primary', action_id: ACTION.NEW_REQUEST, value: 'home' },
        { type: 'button', text: plain('Refresh'), action_id: ACTION.REFRESH_HOME, value: 'home' },
      ],
    },
    { type: 'divider' },
    ...rosterBlocks(),
    { type: 'divider' },
    section(`*Upcoming reservations*`),
    ...upcoming,
  ];
  if (mine.length) {
    blocks.push({ type: 'divider' });
    blocks.push(section(`*Your open requests*\n${mine.map((r) => `• ${r.id} · ${esc(r.account)} · ${R.describeWho(r)} · ${R.slackRange(r.startTs, r.endTs)} · ${STATUS_META[r.status].label}`).join('\n')}`));
  }
  const freeAll = R.availability(store, { from: now, to: now + 7 * 86400 }).members
    .filter((m) => m.freeDays === m.days.length)
    .map((m) => m.member.name);
  blocks.push({ type: 'divider' });
  blocks.push(section(`*Free for the next 7 days*\n${freeAll.length ? freeAll.join(', ') : '_Nobody is fully free — try `/fcto free <dates>` for a day-by-day view._'}`));
  blocks.push(context(`Admins: ${getAdminIds().map((id) => `<@${id}>`).join(', ') || '_none configured_'} · \`/fcto help\` for commands`));
  return { type: 'home', blocks: blocks.slice(0, 100) };
}

function helpText() {
  return [
    '*Field CTO reservations*',
    '• `/fcto request` — open the request form (or `/fcto` alone)',
    '• `/fcto schedule` — this week · `/fcto schedule next` — next week · `/fcto schedule month`',
    '• `/fcto schedule @person` — one Field CTO\'s reservations · `/fcto schedule me` — your requests',
    '• `/fcto free oct 22` · `/fcto free oct 22-24` · `/fcto free next week` — who has no approved reservation on those days',
    '• `/fcto roster` — who the Field CTOs are and their current local time',
    'Approve / Decline / Claim / Reassign happen on the request card in the channel. Admins and the named Field CTO can act; everyone else gets a polite no.',
  ].join('\n');
}

module.exports = {
  esc,
  availabilityBlocks,
  CALLBACK,
  ACTION,
  STATUS_META,
  requestModal,
  readRequestModal,
  modalErrors,
  declineModal,
  readDeclineModal,
  assignModal,
  readAssignModal,
  requestCard,
  cardText,
  threadNote,
  scheduleBlocks,
  rosterBlocks,
  homeView,
  helpText,
  mention,
};
