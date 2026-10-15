'use strict';

// Field CTO reservation domain logic: create / approve / decline / claim /
// reassign / cancel, conflict detection, permissions, schedule queries and
// time formatting. No Slack calls here — see routes/fcto.js and blocks.js.

const { getRoster, findMember, getAdminIds, REGION_LABELS } = require('../../../config/fcto-roster');

const STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  DECLINED: 'declined',
  CANCELLED: 'cancelled',
});

const DURATIONS = Object.freeze({
  '30m': { label: '30 minutes', minutes: 30 },
  '1h': { label: '1 hour', minutes: 60 },
  '90m': { label: '90 minutes', minutes: 90 },
  '2h': { label: '2 hours', minutes: 120 },
  half_day: { label: 'Half day (4h)', minutes: 240 },
  full_day: { label: 'Full day (8h)', minutes: 480 },
  custom: { label: 'Custom end time', minutes: null },
});

const PREFERENCES = Object.freeze({
  ANY: 'Any Field CTO',
  US: 'Any Field CTO — US hours',
  EU: 'Any Field CTO — EU hours',
  JP: 'Any Field CTO — Japan / APAC hours',
});

const MAX_TEXT = 500;
const MAX_SPAN_DAYS = 14;
const MIN_LEAD_SECONDS = -15 * 60; // allow "starting a few minutes ago" (clock skew / same-hour asks)

class ReservationError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

function clean(value, max = MAX_TEXT) {
  if (value === undefined || value === null) return '';
  return Array.from(String(value)).filter((ch) => { const c = ch.charCodeAt(0); return c > 31 || c === 9 || c === 10 || c === 13; }).join('').trim().slice(0, max);
}

function toEpoch(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function isAdmin(userId, env = process.env) {
  return getAdminIds(env).includes(String(userId || '').toUpperCase());
}

function memberBySlackId(userId, env = process.env) {
  const id = String(userId || '').toUpperCase();
  return id ? getRoster(env).find((m) => m.slackId === id) || null : null;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function findConflicts(store, memberKey, startTs, endTs, excludeId) {
  if (!memberKey) return [];
  return store.all().filter((r) => r.id !== excludeId
    && r.status === STATUS.APPROVED
    && r.assigneeKey === memberKey
    && overlaps(startTs, endTs, r.startTs, r.endTs));
}

function nextId(state) {
  const seq = state.nextSeq;
  state.nextSeq = seq + 1;
  return { id: `FCR-${seq}`, seq };
}

function pushHistory(res, by, action, detail) {
  res.history = res.history || [];
  res.history.push({ at: Math.floor(Date.now() / 1000), by, action, detail: detail || '' });
  res.updatedAt = Math.floor(Date.now() / 1000);
  res.rev = (res.rev || 0) + 1;
}

/**
 * Build and validate a reservation request. Returns the stored reservation.
 */
async function createRequest(store, input, { now = Math.floor(Date.now() / 1000), env = process.env } = {}) {
  const requesterId = clean(input.requesterId, 32).toUpperCase();
  if (!/^[A-Z0-9]{1,32}$/.test(requesterId)) throw new ReservationError('bad_requester', 'Missing requester.');

  const account = clean(input.account, 120);
  if (!account) throw new ReservationError('account_required', 'Tell us which account or customer this is for.', { field: 'account' });

  const purpose = clean(input.purpose, MAX_TEXT);
  if (!purpose) throw new ReservationError('purpose_required', 'Describe what the Field CTO is needed for.', { field: 'purpose' });

  const startTs = toEpoch(input.startTs);
  if (!startTs) throw new ReservationError('start_required', 'Pick a start date and time.', { field: 'start' });
  if (startTs - now < MIN_LEAD_SECONDS) throw new ReservationError('start_in_past', 'The start time is in the past.', { field: 'start' });

  const durationKey = clean(input.durationKey, 20);
  const duration = DURATIONS[durationKey];
  if (!duration) throw new ReservationError('duration_required', 'Pick a duration.', { field: 'duration' });

  let endTs;
  if (duration.minutes === null) {
    endTs = toEpoch(input.endTs);
    if (!endTs) throw new ReservationError('end_required', 'Pick an end date and time for a custom block.', { field: 'end' });
  } else {
    endTs = startTs + duration.minutes * 60;
  }
  if (endTs <= startTs) throw new ReservationError('end_before_start', 'The end time must be after the start time.', { field: 'end' });
  if (endTs - startTs > MAX_SPAN_DAYS * 86400) {
    throw new ReservationError('too_long', `A single reservation can span at most ${MAX_SPAN_DAYS} days.`, { field: 'end' });
  }

  const who = clean(input.who, 40).toUpperCase();
  let requestType;
  let requestedKey = null;
  let preference = null;
  if (who.startsWith('MEMBER:')) {
    const member = findMember(who.slice('MEMBER:'.length), env);
    if (!member) throw new ReservationError('unknown_member', 'That Field CTO is not on the roster.', { field: 'who' });
    requestType = 'specific';
    requestedKey = member.key;
  } else if (who.startsWith('ANY:')) {
    const pref = who.slice('ANY:'.length);
    if (!PREFERENCES[pref]) throw new ReservationError('unknown_preference', 'Pick who you need.', { field: 'who' });
    requestType = 'any';
    preference = pref;
  } else {
    throw new ReservationError('who_required', 'Pick who you need.', { field: 'who' });
  }

  const meetingLink = clean(input.meetingLink, 300);
  if (meetingLink && !/^https?:\/\/[^\s<>|]+$/i.test(meetingLink)) {
    throw new ReservationError('bad_link', 'The meeting link must start with http:// or https://.', { field: 'meetingLink' });
  }

  const reservation = {
    id: null,
    seq: null,
    status: STATUS.PENDING,
    requesterId,
    account,
    purpose,
    notes: clean(input.notes, MAX_TEXT),
    meetingLink,
    requestType,
    requestedKey,
    preference,
    assigneeKey: requestType === 'specific' ? requestedKey : null,
    startTs,
    endTs,
    durationKey,
    channelId: clean(input.channelId, 32) || null,
    messageTs: null,
    createdAt: now,
    updatedAt: now,
    decidedBy: null,
    decidedAt: null,
    declineReason: '',
    history: [],
  };

  return store.transact((state) => {
    Object.assign(reservation, nextId(state));
    pushHistory(reservation, requesterId, 'requested');
    state.reservations.push(reservation);
    return { ...reservation };
  });
}

function requireReservation(store, id) {
  const res = store.get(id);
  if (!res) throw new ReservationError('not_found', `Reservation ${id} was not found.`);
  return res;
}

// Who may approve / decline this request: admins, the Field CTO it names,
// and (once assigned) the assignee.
function canDecide(res, userId, env = process.env) {
  if (isAdmin(userId, env)) return true;
  const member = memberBySlackId(userId, env);
  if (!member) return false;
  return member.key === res.requestedKey || member.key === res.assigneeKey;
}

function canClaim(res, userId, env = process.env) {
  return res.status === STATUS.PENDING && res.requestType === 'any' && !!memberBySlackId(userId, env);
}

function canCancel(res, userId, env = process.env) {
  return res.requesterId === String(userId || '').toUpperCase() || isAdmin(userId, env);
}

function canReassign(res, userId, env = process.env) {
  return isAdmin(userId, env);
}

function assertOpen(res) {
  if (res.status !== STATUS.PENDING) {
    throw new ReservationError('not_pending', `${res.id} is already ${res.status}.`);
  }
}

function conflictOrForce(store, res, memberKey, force) {
  const conflicts = findConflicts(store, memberKey, res.startTs, res.endTs, res.id);
  if (conflicts.length && !force) {
    const member = findMember(memberKey);
    throw new ReservationError('conflict', `${member ? member.name : memberKey} is already reserved for an overlapping time.`, { conflicts });
  }
  return conflicts;
}

async function approve(store, id, { by, assigneeKey, force = false, env = process.env }) {
  return store.transact(() => {
    const res = requireReservation(store, id);
    assertOpen(res);
    if (!canDecide(res, by, env)) throw new ReservationError('forbidden', 'Only an admin or the requested Field CTO can approve this request.');
    const targetKey = assigneeKey ? (findMember(assigneeKey, env) || {}).key : res.assigneeKey;
    if (!targetKey) throw new ReservationError('assignee_required', 'Pick which Field CTO takes this request before approving.', { needsAssignee: true });
    if (assigneeKey && targetKey !== res.assigneeKey && !isAdmin(by, env)) {
      throw new ReservationError('forbidden', 'Only an admin can assign a different Field CTO.');
    }
    conflictOrForce(store, res, targetKey, force);
    res.assigneeKey = targetKey;
    res.status = STATUS.APPROVED;
    res.decidedBy = String(by).toUpperCase();
    res.decidedAt = Math.floor(Date.now() / 1000);
    pushHistory(res, res.decidedBy, 'approved', targetKey);
    return { ...res };
  });
}

async function claim(store, id, { by, force = false, env = process.env }) {
  return store.transact(() => {
    const res = requireReservation(store, id);
    assertOpen(res);
    if (!canClaim(res, by, env)) throw new ReservationError('forbidden', 'Only a Field CTO can claim an open request.');
    const member = memberBySlackId(by, env);
    conflictOrForce(store, res, member.key, force);
    res.assigneeKey = member.key;
    res.status = STATUS.APPROVED;
    res.decidedBy = String(by).toUpperCase();
    res.decidedAt = Math.floor(Date.now() / 1000);
    pushHistory(res, res.decidedBy, 'claimed', member.key);
    return { ...res };
  });
}

async function decline(store, id, { by, reason = '', env = process.env }) {
  return store.transact(() => {
    const res = requireReservation(store, id);
    assertOpen(res);
    if (!canDecide(res, by, env)) throw new ReservationError('forbidden', 'Only an admin or the requested Field CTO can decline this request.');
    res.status = STATUS.DECLINED;
    res.declineReason = clean(reason, MAX_TEXT);
    res.decidedBy = String(by).toUpperCase();
    res.decidedAt = Math.floor(Date.now() / 1000);
    pushHistory(res, res.decidedBy, 'declined', res.declineReason);
    return { ...res };
  });
}

async function cancel(store, id, { by, env = process.env }) {
  return store.transact(() => {
    const res = requireReservation(store, id);
    if (res.status === STATUS.CANCELLED || res.status === STATUS.DECLINED) {
      throw new ReservationError('not_open', `${res.id} is already ${res.status}.`);
    }
    if (!canCancel(res, by, env)) throw new ReservationError('forbidden', 'Only the requester or an admin can cancel this request.');
    res.status = STATUS.CANCELLED;
    pushHistory(res, String(by).toUpperCase(), 'cancelled');
    return { ...res };
  });
}

async function reassign(store, id, { by, assigneeKey, force = false, env = process.env }) {
  return store.transact(() => {
    const res = requireReservation(store, id);
    if (res.status === STATUS.CANCELLED || res.status === STATUS.DECLINED) {
      throw new ReservationError('not_open', `${res.id} is already ${res.status}.`);
    }
    if (!canReassign(res, by, env)) throw new ReservationError('forbidden', 'Only an admin can reassign a request.');
    const member = findMember(assigneeKey, env);
    if (!member) throw new ReservationError('unknown_member', 'That Field CTO is not on the roster.');
    conflictOrForce(store, res, member.key, force);
    const previous = res.assigneeKey;
    res.assigneeKey = member.key;
    if (res.status === STATUS.PENDING) {
      res.status = STATUS.APPROVED;
      res.decidedBy = String(by).toUpperCase();
      res.decidedAt = Math.floor(Date.now() / 1000);
    }
    pushHistory(res, String(by).toUpperCase(), 'reassigned', `${previous || '-'} -> ${member.key}`);
    return { ...res };
  });
}

async function setMessage(store, id, channelId, messageTs) {
  return store.transact(() => {
    const res = requireReservation(store, id);
    res.channelId = channelId;
    res.messageTs = messageTs;
    return { ...res };
  });
}

// ─── Queries ────────────────────────────────────────────────────────────────

function listReservations(store, { from, to, memberKey, requesterId, statuses } = {}) {
  const wanted = statuses || [STATUS.PENDING, STATUS.APPROVED];
  return store.all()
    .filter((r) => wanted.includes(r.status))
    .filter((r) => (from === undefined || r.endTs > from) && (to === undefined || r.startTs < to))
    .filter((r) => !memberKey || r.assigneeKey === memberKey)
    .filter((r) => !requesterId || r.requesterId === requesterId)
    .sort((a, b) => a.startTs - b.startTs || a.seq - b.seq);
}

// Candidates for an open request: roster members matching the regional
// preference first, each annotated with whether they are free.
function suggestAssignees(store, res, env = process.env) {
  return getRoster(env)
    .map((m) => ({
      ...m,
      preferred: !res.preference || res.preference === 'ANY' || m.region === res.preference,
      conflicts: findConflicts(store, m.key, res.startTs, res.endTs, res.id),
    }))
    .sort((a, b) => Number(b.preferred) - Number(a.preferred)
      || a.conflicts.length - b.conflicts.length
      || a.name.localeCompare(b.name));
}

// ─── Time formatting ────────────────────────────────────────────────────────

function formatInTz(ts, tz, opts = {}) {
  const date = new Date(ts * 1000);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    ...opts,
  }).formatToParts(date);
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
  return {
    day: `${get('weekday')} ${get('month')} ${get('day')}`,
    time: `${get('hour')}:${get('minute')} ${get('dayPeriod')}`.trim(),
    zone: get('timeZoneName'),
  };
}

function formatRangeInTz(startTs, endTs, tz) {
  const s = formatInTz(startTs, tz);
  const e = formatInTz(endTs, tz);
  if (s.day === e.day) return `${s.day}, ${s.time} – ${e.time} ${e.zone}`;
  return `${s.day} ${s.time} – ${e.day} ${e.time} ${e.zone}`;
}

// Slack renders <!date> in each viewer's own time zone.
function slackDate(ts, tz = 'UTC') {
  const f = formatInTz(ts, tz);
  return `<!date^${ts}^{date_short_pretty} {time}|${f.day} ${f.time} ${f.zone}>`;
}

function slackRange(startTs, endTs) {
  const sameDay = new Date(startTs * 1000).toISOString().slice(0, 10) === new Date(endTs * 1000).toISOString().slice(0, 10);
  const end = sameDay
    ? `<!date^${endTs}^{time}|${formatInTz(endTs, 'UTC').time} UTC>`
    : slackDate(endTs);
  return `${slackDate(startTs)} – ${end}`;
}

// Current assignee first; the original ask is kept as context when an admin
// moved the request to somebody else.
function describeWho(res, env = process.env) {
  const nameOf = (key) => {
    const m = key ? findMember(key, env) : null;
    return m ? m.name : key;
  };
  if (res.requestType === 'specific') {
    if (res.assigneeKey && res.assigneeKey !== res.requestedKey) {
      return `${nameOf(res.assigneeKey)} (requested ${nameOf(res.requestedKey)})`;
    }
    return nameOf(res.requestedKey);
  }
  const pref = PREFERENCES[res.preference] || PREFERENCES.ANY;
  return res.assigneeKey ? `${nameOf(res.assigneeKey)} (${pref})` : pref;
}

function durationLabel(res) {
  const d = DURATIONS[res.durationKey];
  if (d && d.minutes !== null) return d.label;
  const minutes = Math.round((res.endTs - res.startTs) / 60);
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? '' : 's'}`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'}`;
  return `${minutes} minutes`;
}

module.exports = {
  STATUS,
  DURATIONS,
  PREFERENCES,
  REGION_LABELS,
  ReservationError,
  createRequest,
  approve,
  claim,
  decline,
  cancel,
  reassign,
  setMessage,
  listReservations,
  suggestAssignees,
  findConflicts,
  canDecide,
  canClaim,
  canCancel,
  canReassign,
  isAdmin,
  memberBySlackId,
  formatInTz,
  formatRangeInTz,
  slackDate,
  slackRange,
  describeWho,
  durationLabel,
  clean,
};
