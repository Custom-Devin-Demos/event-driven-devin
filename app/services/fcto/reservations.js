'use strict';

// Field CTO reservation domain logic: create / approve / decline / claim /
// reassign / cancel, conflict detection, permissions, schedule queries and
// time formatting. No Slack calls here — see routes/fcto.js and blocks.js.

const { getRoster, findMember, getAdminIds, REGION_LABELS } = require('../../../config/fcto-roster');
const Q = require('../../../config/fcto-qualifications');
const G = require('../../../config/fcto-guide');

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
const MAX_DETAIL = 1000;
const MAX_CONTACTS = 10;
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
  const text = Array.from(String(value)).filter((ch) => { const c = ch.charCodeAt(0); return c > 31 || c === 9 || c === 10 || c === 13; }).join('').trim();
  return Array.from(text).slice(0, max).join('');
}

const SAFE_URL = /^https?:\/\/[^\s<>|]+$/i;
const SALESFORCE_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.(lightning\.force\.com|salesforce\.com)$/i;
const SALESFORCE_RECORD = { opportunity: ['Opportunity', '006'], contact: ['Contact', '003'] };

// True for a Salesforce Opportunity / Contact record URL: Lightning
// /lightning/r/<Object>/<id>[/view] or Classic /<id>, with a 15/18-char id.
// Format check only: there is no Salesforce API connection.
function isSalesforceRecord(url, type) {
  const [object, prefix] = SALESFORCE_RECORD[type];
  if (!/^https:\/\/[^\s<>|]+$/i.test(url)) return false;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.username || parsed.password || parsed.port || !SALESFORCE_HOST.test(parsed.hostname)) return false;
  const id = `${prefix}[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?`;
  return new RegExp(`^/(?:lightning/r/${object}/${id}(?:/view)?|${id})/?$`, 'i').test(parsed.pathname);
}

// 'meeting' (also for requests made before request types) or 'speaking'.
function kindOf(res) {
  return res && res.kind === 'speaking' ? 'speaking' : 'meeting';
}

function isSpeakingReviewer(userId, env = process.env) {
  return G.speakingReviewerIds(env).includes(String(userId || '').toUpperCase());
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
function meetingDetails(input) {
  const attendees = clean(input.attendees, MAX_TEXT);
  if (!attendees) {
    throw new ReservationError('attendees_required', 'List the key customer attendees with their titles.', { field: 'attendees' });
  }
  const opportunityUrl = clean(input.opportunityUrl, 300);
  if (opportunityUrl && !isSalesforceRecord(opportunityUrl, 'opportunity')) {
    throw new ReservationError('bad_opportunity', 'Paste a Salesforce Opportunity link (…lightning.force.com/lightning/r/Opportunity/006…), or leave it empty.', { field: 'opportunityUrl' });
  }
  const contactUrls = Array.from(new Set(String(input.contactUrls || '').split(/[\s,]+/).filter(Boolean)));
  if (contactUrls.length > MAX_CONTACTS) {
    throw new ReservationError('too_many_contacts', `Link up to ${MAX_CONTACTS} contacts.`, { field: 'contactUrls' });
  }
  const badContact = contactUrls.find((u) => u.length > 300 || !isSalesforceRecord(u, 'contact'));
  if (badContact) {
    throw new ReservationError('bad_contact', `Not a Salesforce Contact link: ${badContact.slice(0, 80)}. Paste one Contact URL per line, or leave it empty.`, { field: 'contactUrls' });
  }
  return { attendees, opportunityUrl, contactUrls };
}

function speakingDetails(input) {
  const eventUrl = clean(input.eventUrl, 300);
  if (!eventUrl) throw new ReservationError('event_link_required', 'Add a link to the event page.', { field: 'eventUrl' });
  if (!SAFE_URL.test(eventUrl)) throw new ReservationError('bad_event_link', 'The event link must start with http:// or https://.', { field: 'eventUrl' });
  const audienceSize = clean(input.audienceSize, 20).toUpperCase();
  if (!G.AUDIENCE_SIZE[audienceSize]) throw new ReservationError('audience_size_required', 'Pick the expected audience size.', { field: 'audienceSize' });
  const deadline = clean(input.deadline, 10);
  if (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) throw new ReservationError('bad_deadline', 'Pick a valid date.', { field: 'deadline' });
  return { eventUrl, audienceSize, deadline: deadline || null };
}

async function createRequest(store, input, { now = Math.floor(Date.now() / 1000), env = process.env } = {}) {
  const requesterId = clean(input.requesterId, 32).toUpperCase();
  if (!/^[A-Z0-9]{1,32}$/.test(requesterId)) throw new ReservationError('bad_requester', 'Missing requester.');

  const kindKey = clean(input.kind, 20).toUpperCase() || 'MEETING';
  if (!G.KIND[kindKey]) throw new ReservationError('kind_required', 'Pick a request type.', { field: 'kind' });
  const kind = kindKey === 'SPEAKING' ? 'speaking' : 'meeting';
  const speaking = kind === 'speaking';

  const account = clean(input.account, 120);
  if (!account) {
    throw new ReservationError('account_required', speaking ? 'Tell us the event name.' : 'Tell us which account or customer this is for.', { field: 'account' });
  }

  const purpose = clean(input.purpose, MAX_DETAIL);
  const minDetail = speaking ? G.MIN_TOPIC_CHARS : G.MIN_GOAL_CHARS;
  if (purpose.length < minDetail) {
    const ask = speaking
      ? 'Describe the talk and why it needs a Field CTO'
      : 'Describe what the customer wants from a Field CTO and why your SE/AE can\'t cover it';
    throw new ReservationError('purpose_too_short', `${ask} (at least ${minDetail} characters; you have ${purpose.length}).`, { field: 'purpose' });
  }

  let audience = null;
  let industry = null;
  if (!speaking) {
    audience = clean(input.audience, 20).toUpperCase();
    if (!Q.AUDIENCE[audience]) throw new ReservationError('audience_required', 'Pick the audience for this meeting.', { field: 'audience' });
    if (!Q.AUDIENCE[audience].eligible) throw new ReservationError('audience_ineligible', Q.BELOW_MESSAGE, { field: 'audience' });
  }
  const country = clean(input.country, 20).toUpperCase();
  if (!Q.COUNTRY[country]) {
    throw new ReservationError('country_required', speaking ? 'Pick the event\'s country.' : 'Pick the customer\'s country.', { field: 'country' });
  }
  if (!speaking) {
    industry = clean(input.industry, 20).toUpperCase();
    if (!Q.INDUSTRY[industry]) throw new ReservationError('industry_required', 'Pick the customer\'s industry.', { field: 'industry' });
  }

  const details = speaking ? speakingDetails(input) : meetingDetails(input);

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
  if (meetingLink && !SAFE_URL.test(meetingLink)) {
    throw new ReservationError('bad_link', 'The meeting link must start with http:// or https://.', { field: 'meetingLink' });
  }

  const reservation = {
    id: null,
    seq: null,
    status: STATUS.PENDING,
    requesterId,
    kind,
    account,
    purpose,
    audience,
    country,
    industry,
    ...details,
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
// Earned speaking is decided by admins and the speaking reviewer only.
function canDecide(res, userId, env = process.env) {
  if (isAdmin(userId, env)) return true;
  if (kindOf(res) === 'speaking') return isSpeakingReviewer(userId, env);
  const member = memberBySlackId(userId, env);
  if (!member) return false;
  return member.key === res.requestedKey || member.key === res.assigneeKey;
}

function canClaim(res, userId, env = process.env) {
  return kindOf(res) === 'meeting'
    && res.status === STATUS.PENDING && res.requestType === 'any' && !!memberBySlackId(userId, env);
}

function canCancel(res, userId, env = process.env) {
  return res.requesterId === String(userId || '').toUpperCase() || isAdmin(userId, env);
}

function canReassign(res, userId, env = process.env) {
  return isAdmin(userId, env) || (kindOf(res) === 'speaking' && isSpeakingReviewer(userId, env));
}

function decideRefusal(res, verb) {
  return kindOf(res) === 'speaking'
    ? `Only the speaking reviewer or an admin can ${verb} an earned speaking request.`
    : `Only an admin or the requested Field CTO can ${verb} this request.`;
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
    if (!canDecide(res, by, env)) throw new ReservationError('forbidden', decideRefusal(res, 'approve'));
    const targetKey = assigneeKey ? (findMember(assigneeKey, env) || {}).key : res.assigneeKey;
    if (!targetKey) throw new ReservationError('assignee_required', 'Pick which Field CTO takes this request before approving.', { needsAssignee: true });
    if (assigneeKey && targetKey !== res.assigneeKey && !canReassign(res, by, env)) {
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
    if (!canDecide(res, by, env)) throw new ReservationError('forbidden', decideRefusal(res, 'decline'));
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
    if (!canReassign(res, by, env)) throw new ReservationError('forbidden', kindOf(res) === 'speaking' ? 'Only the speaking reviewer or an admin can reassign this request.' : 'Only an admin can reassign a request.');
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

// Candidates for an open request: the Field CTO the routing rules recommend
// for its country/industry first, then members matching the regional
// preference, each annotated with whether they are free.
function suggestAssignees(store, res, env = process.env) {
  const suggestion = Q.suggestWho(res);
  const recommendedKey = suggestion && suggestion.who.startsWith('MEMBER:') ? suggestion.who.slice('MEMBER:'.length) : null;
  return getRoster(env)
    .map((m) => ({
      ...m,
      recommended: m.key === recommendedKey,
      preferred: !res.preference || res.preference === 'ANY' || m.region === res.preference,
      conflicts: findConflicts(store, m.key, res.startTs, res.endTs, res.id),
    }))
    .sort((a, b) => Number(b.recommended) - Number(a.recommended)
      || Number(b.preferred) - Number(a.preferred)
      || a.conflicts.length - b.conflicts.length
      || a.name.localeCompare(b.name));
}

// The [start, end) the request form currently describes, or null while it is
// incomplete or invalid.
function requestWindow({ startTs, durationKey, endTs } = {}) {
  const start = toEpoch(startTs);
  const duration = DURATIONS[durationKey];
  if (!start || !duration) return null;
  const end = duration.minutes === null ? toEpoch(endTs) : start + duration.minutes * 60;
  if (!end || end <= start || end - start > MAX_SPAN_DAYS * 86400) return null;
  return { startTs: start, endTs: end };
}

// The Field CTOs a request-form "who" value covers, each with the approved
// reservations overlapping the window, free people first. Null for no pick.
function whoIsFree(store, { who, startTs, endTs }, env = process.env) {
  const value = String(who || '').toUpperCase();
  let members;
  if (value.startsWith('MEMBER:')) {
    const member = findMember(value.slice('MEMBER:'.length), env);
    members = member ? [member] : [];
  } else if (value.startsWith('ANY:') && PREFERENCES[value.slice('ANY:'.length)]) {
    const pref = value.slice('ANY:'.length);
    members = getRoster(env).filter((m) => pref === 'ANY' || m.region === pref);
  } else {
    return null;
  }
  return members
    .map((member) => ({ member, conflicts: findConflicts(store, member.key, startTs, endTs) }))
    .sort((a, b) => a.conflicts.length - b.conflicts.length || a.member.name.localeCompare(b.member.name));
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

// "VP · Germany · Finance"; empty for requests made before qualifications.
function qualificationsLabel(res) {
  return [Q.AUDIENCE[res.audience], Q.COUNTRY[res.country], Q.INDUSTRY[res.industry]]
    .filter(Boolean).map((x) => x.label).join(' · ');
}

function durationLabel(res) {
  const d = DURATIONS[res.durationKey];
  if (d && d.minutes !== null) return d.label;
  const minutes = Math.round((res.endTs - res.startTs) / 60);
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? '' : 's'}`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'}`;
  return `${minutes} minutes`;
}

// ─── Availability ───────────────────────────────────────────────────────────

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY = 86400;
const DAY_BOOKED_SECONDS = 6 * 3600;
const MAX_AVAILABILITY_DAYS = 31;

function utcDay(ts) {
  return Math.floor(ts / DAY) * DAY;
}

/**
 * Parse the free-text date range of `/fcto free …` into UTC day bounds
 * (`to` exclusive). Accepts "oct 22", "oct 22-24", "22 oct", "oct 30 - nov 2",
 * "2026-11-03..2026-11-05", "11/3", "today", "tomorrow", "week", "next week",
 * "month". Dates without a year roll forward to the next occurrence.
 * Returns null when it can't be read.
 */
function parseDateRange(text, now = Math.floor(Date.now() / 1000)) {
  const s = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const today = utcDay(now);
  const year = new Date(now * 1000).getUTCFullYear();
  if (!s || s === 'today') return { from: today, to: today + DAY };
  if (s === 'tomorrow') return { from: today + DAY, to: today + 2 * DAY };
  if (s === 'week' || s === 'this week') return { from: today, to: today + 7 * DAY };
  if (s === 'next' || s === 'next week') {
    const dow = (new Date(today * 1000).getUTCDay() + 6) % 7;
    const monday = today - dow * DAY + 7 * DAY;
    return { from: monday, to: monday + 7 * DAY };
  }
  if (s === 'month') return { from: today, to: today + 31 * DAY };

  const parseOne = (part, ctx) => {
    const p = part.trim();
    let m;
    if ((m = p.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return { y: +m[1], mo: +m[2] - 1, d: +m[3] };
    if ((m = p.match(/^([a-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?$/))) {
      const mo = MONTHS.indexOf(m[1].slice(0, 3));
      return mo < 0 ? null : { y: m[3] ? +m[3] : null, mo, d: +m[2] };
    }
    if ((m = p.match(/^(\d{1,2})(?:st|nd|rd|th)? ([a-z]{3,9})\.?(?:,? (\d{4}))?$/))) {
      const mo = MONTHS.indexOf(m[2].slice(0, 3));
      return mo < 0 ? null : { y: m[3] ? +m[3] : null, mo, d: +m[1] };
    }
    if ((m = p.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/))) return { y: m[3] ? +m[3] : null, mo: +m[1] - 1, d: +m[2] };
    if (ctx && (m = p.match(/^(\d{1,2})(?:st|nd|rd|th)?$/))) return { y: ctx.y, mo: ctx.mo, d: +m[1] };
    return null;
  };
  const toTs = (o, notBefore) => {
    if (!o || o.mo < 0 || o.mo > 11 || o.d < 1 || o.d > 31) return null;
    let ts = Date.UTC(o.y || year, o.mo, o.d) / 1000;
    for (let extra = 1; !o.y && ts < notBefore && extra <= 2; extra += 1) ts = Date.UTC(year + extra, o.mo, o.d) / 1000;
    return new Date(ts * 1000).getUTCDate() === o.d ? ts : null;
  };

  let parts;
  let m;
  if ((m = s.match(/^(\d{4}-\d{1,2}-\d{1,2})\s*(?:-|–|—|\.\.|to|through)\s*(\d{4}-\d{1,2}-\d{1,2})$/))) parts = [m[1], m[2]];
  else if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) parts = [s];
  else parts = s.split(/\s*(?:–|—|\.\.|\bto\b|\bthrough\b|\bthru\b)\s*|(?<=\d)\s*-\s*(?=[a-z0-9])/).filter(Boolean);
  if (parts.length < 1 || parts.length > 2) return null;

  const first = parseOne(parts[0]);
  const from = toTs(first, today);
  if (from === null) return null;
  if (parts.length === 1) return { from, to: from + DAY };
  const end = toTs(parseOne(parts[1], first), from);
  if (end === null || end < from) return null;
  return { from, to: end + DAY };
}

const OFFSET_FMT = new Map();
function tzOffsetSeconds(ts, tz) {
  let fmt = OFFSET_FMT.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    OFFSET_FMT.set(tz, fmt);
  }
  const p = {};
  fmt.formatToParts(new Date(ts * 1000)).forEach((x) => { if (x.type !== 'literal') p[x.type] = Number(x.value); });
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) / 1000 - ts;
}

// Midnight of the calendar date `utcMidnight` names, in `tz`. Two passes so a
// DST change on that night still lands on local 00:00.
function localDayStart(utcMidnight, tz) {
  const guess = utcMidnight - tzOffsetSeconds(utcMidnight, tz);
  return utcMidnight - tzOffsetSeconds(guess, tz);
}

/**
 * Who is free on each calendar date of [from, to)? Dates are evaluated in each
 * Field CTO's own time zone (Akira's "Oct 23" is JST). Only approved
 * reservations count (pending ones don't block anyone). A day is `booked`
 * once 6h+ of it is reserved, `partial` for anything less, else `free`.
 */
function availability(store, { from, to, env = process.env }) {
  const days = [];
  for (let d = utcDay(from); d < to && days.length < MAX_AVAILABILITY_DAYS; d += DAY) days.push(d);
  const approved = store.all().filter((r) => r.status === STATUS.APPROVED && r.endTs > from - DAY && r.startTs < to + DAY);
  const members = getRoster(env).map((member) => {
    const perDay = days.map((d) => {
      const startTs = localDayStart(d, member.tz);
      const endTs = localDayStart(d + DAY, member.tz);
      const busy = approved
        .filter((r) => r.assigneeKey === member.key && overlaps(r.startTs, r.endTs, startTs, endTs))
        .map((r) => ({ id: r.id, account: r.account, startTs: Math.max(r.startTs, startTs), endTs: Math.min(r.endTs, endTs) }))
        .sort((a, b) => a.startTs - b.startTs);
      const seconds = busy.reduce((n, b) => n + (b.endTs - b.startTs), 0);
      let status = 'free';
      if (busy.length) status = seconds >= DAY_BOOKED_SECONDS ? 'booked' : 'partial';
      return { day: d, startTs, endTs, status, busy };
    });
    return { member, days: perDay, freeDays: perDay.filter((x) => x.status === 'free').length };
  });
  return { days, members };
}

module.exports = {
  qualificationsLabel,
  parseDateRange,
  availability,
  localDayStart,
  MAX_AVAILABILITY_DAYS,
  STATUS,
  DURATIONS,
  PREFERENCES,
  REGION_LABELS,
  ReservationError,
  createRequest,
  isSalesforceRecord,
  kindOf,
  isSpeakingReviewer,
  decideRefusal,
  approve,
  claim,
  decline,
  cancel,
  reassign,
  setMessage,
  listReservations,
  suggestAssignees,
  findConflicts,
  requestWindow,
  whoIsFree,
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
