const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const SEED = require('./assessmentscheduling-seed.json');

const SERVICE = 'scheduling-service';
const SEARCH_ROUTE = '/api/oncall/assessmentscheduling/sessions/search';
const BOOKINGS_ROUTE = '/api/oncall/assessmentscheduling/bookings';
const CAPACITY_ROUTE = '/api/oncall/assessmentscheduling/sessions/capacity';

// Demo state is shared by everyone presenting the page; it returns to the seed
// after a quiet spell so the next demo starts from the same numbers.
const STATE_TTL_MS = 30 * 60 * 1000;
// Same limit as the admin UI's validateCapacity.
const MAX_CAPACITY = 500;

const CENTERS = SEED.centers;
const EXAMS = SEED.exams;
const ACCOMMODATION_CODES = ['ET25', 'ET50', 'SR', 'RB'];
// Extra-time codes need an accommodation-capable seat; SR and RB do not.
const SEATED_ACCOMMODATIONS = new Set(['ET25', 'ET50']);

let state = null;
let lastMutationAt = 0;

function seedState() {
  const sessions = new Map();
  const fields = SEED.sessionFields;
  for (const row of SEED.sessions) {
    const s = Object.fromEntries(fields.map((f, i) => [f, row[i]]));
    // Seated bookings are not exposed by the v2 API; synthesise them from the seeded counts.
    const bookings = [];
    for (let i = 0; i < s.bookedSeats; i += 1) {
      bookings.push({
        bookingId: s.sessionId * 1000 + i + 1,
        candidateNumber: null,
        accommodationCode: i < s.accommodationUsed ? 'ET25' : null,
        status: 'BOOKED',
        bookedAt: i,
      });
    }
    sessions.set(s.sessionId, {
      sessionId: s.sessionId,
      examCode: s.examCode,
      centerCode: s.centerCode,
      roomName: s.roomName,
      startsAt: s.startsAt,
      capacity: s.capacity,
      accommodationCapacity: s.accommodationCapacity,
      status: s.status,
      bookings,
    });
  }
  const wf = SEED.waitlistFields;
  for (const row of SEED.waitlists) {
    const w = Object.fromEntries(wf.map((f, i) => [f, row[i]]));
    const session = sessions.get(w.sessionId);
    if (!session) continue;
    session.bookings.push({
      bookingId: w.bookingId,
      candidateNumber: w.candidateNumber,
      candidateName: w.candidateName,
      accommodationCode: null,
      status: 'WAITLISTED',
      waitlistPosition: w.position,
      addedAt: w.addedAt,
      bookedAt: -1,
    });
  }
  return { sessions, nextBookingId: 900001 };
}

function currentState(now = Date.now()) {
  if (!state || (lastMutationAt && now - lastMutationAt > STATE_TTL_MS)) {
    state = seedState();
    lastMutationAt = 0;
  }
  return state;
}

function touch() {
  lastMutationAt = Date.now();
}

function resetState() {
  state = null;
  lastMutationAt = 0;
}

function requestError(code, message, legacyCode = null) {
  const error = new Error(message);
  error.code = code;
  error.legacyCode = legacyCode;
  return error;
}

const held = (b) => b.status === 'BOOKED' || b.status === 'ATTENDED';

function seatsHeld(session) {
  return session.bookings.filter(held).length;
}

function accommodationUsed(session) {
  return session.bookings.filter((b) => held(b) && SEATED_ACCOMMODATIONS.has(b.accommodationCode)).length;
}

function waitlisted(session) {
  return session.bookings
    .filter((b) => b.status === 'WAITLISTED')
    .sort((a, b) => a.waitlistPosition - b.waitlistPosition);
}

// Same JSON as scheduling-service's SessionResponse.
function sessionView(session) {
  const exam = EXAMS.find((e) => e.examCode === session.examCode);
  const center = CENTERS.find((c) => c.centerCode === session.centerCode);
  const booked = seatsHeld(session);
  return {
    sessionId: session.sessionId,
    examCode: session.examCode,
    examTitle: exam ? exam.title : session.examCode,
    centerCode: session.centerCode,
    centerName: center ? center.name : session.centerCode,
    roomName: session.roomName,
    startsAt: session.startsAt,
    capacity: session.capacity,
    accommodationCapacity: session.accommodationCapacity,
    seatsAvailable: Math.max(0, session.capacity - booked),
    status: session.status,
    bookedSeats: booked,
    accommodationUsed: accommodationUsed(session),
    waitlistCount: waitlisted(session).length,
  };
}

// Only JSON integers or digit-only strings; rejects true, [25], "25abc", 2.5.
function toInteger(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : NaN;
  if (typeof value === 'string' && /^\d{1,9}$/.test(value.trim())) return Number(value.trim());
  return NaN;
}

function parseSessionId(value) {
  const id = toInteger(value);
  if (!Number.isInteger(id) || id <= 0) throw requestError('VALIDATION', 'sessionId must be a positive integer');
  return id;
}

function findSession(sessionId) {
  const session = currentState().sessions.get(sessionId);
  if (!session) throw requestError('SESSION_NOT_FOUND', `Session ${sessionId} not found`);
  return session;
}

function parseDate(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw requestError('VALIDATION', 'Dates must be yyyy-MM-dd');
  }
  return value;
}

/** GET /api/v2/centers and /api/v2/exams. */
function referenceData() {
  return {
    centers: CENTERS.map((c) => ({ ...c })),
    exams: EXAMS.map((e) => ({ ...e })),
  };
}

/**
 * GET /api/v2/centers/{centerCode}/sessions?examCode=&from=&to= on scheduling-service
 * (from inclusive, to exclusive).
 */
function searchSessions(query = {}) {
  const startedAt = Date.now();
  const center = CENTERS.find((c) => c.centerCode === query.centerCode);
  if (!center) throw requestError('CENTER_NOT_FOUND', `Test center ${query.centerCode} not found`);
  const examCode = query.examCode || null;
  if (examCode && !EXAMS.some((e) => e.examCode === examCode)) throw requestError('VALIDATION', `Exam ${examCode} not found`);
  const from = parseDate(query.from);
  const to = parseDate(query.to);

  const sessions = [...currentState().sessions.values()]
    .filter((s) => s.centerCode === center.centerCode && (!examCode || s.examCode === examCode))
    .filter((s) => (!from || s.startsAt.slice(0, 10) >= from) && (!to || s.startsAt.slice(0, 10) < to))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.sessionId - b.sessionId)
    .map(sessionView);

  recordTiming('scheduling_service.sessions.search.latency', Date.now() - startedAt, { service: SERVICE, route: SEARCH_ROUTE });
  return { sessions };
}

/** GET /api/v2/sessions/{sessionId}. */
function getSession(data = {}) {
  return sessionView(findSession(parseSessionId(data.sessionId)));
}

/** GET /api/v2/sessions/{sessionId}/waitlist. */
function getWaitlist(data = {}) {
  const session = findSession(parseSessionId(data.sessionId));
  return waitlisted(session).map((b) => ({
    position: b.waitlistPosition,
    bookingId: b.bookingId,
    candidateNumber: b.candidateNumber,
    candidateName: b.candidateName || null,
    addedAt: b.addedAt,
  }));
}

function nowIso() {
  return new Date().toISOString().slice(0, 19);
}

/**
 * POST /api/v2/bookings on scheduling-service: BOOKED while a seat is free, else
 * WAITLISTED (legacy usp_BookSeat order: 50001, 50002, 50003).
 */
function bookSeat(data = {}) {
  const sessionId = parseSessionId(data.sessionId);
  const candidateNumber = typeof data.candidateNumber === 'string' ? data.candidateNumber.trim().toUpperCase() : '';
  if (!/^NW\d{8}$/.test(candidateNumber)) throw requestError('VALIDATION', 'candidateNumber must be NW followed by 8 digits');
  const accommodationCode = data.accommodationCode ? String(data.accommodationCode).toUpperCase() : null;
  if (accommodationCode && !ACCOMMODATION_CODES.includes(accommodationCode)) {
    throw requestError('VALIDATION', 'accommodationCode must be ET25, ET50, SR or RB');
  }

  const session = findSession(sessionId);
  if (session.status !== 'OPEN') {
    throw requestError('SESSION_NOT_OPEN', `Session ${sessionId} is not open for booking`, 50001);
  }
  if (session.bookings.some((b) => b.candidateNumber === candidateNumber && (held(b) || b.status === 'WAITLISTED'))) {
    throw requestError('DUPLICATE_BOOKING', `Candidate ${candidateNumber} already has an active booking for session ${sessionId}`, 50002);
  }
  const seated = accommodationCode && SEATED_ACCOMMODATIONS.has(accommodationCode);
  if (seated && accommodationUsed(session) >= session.accommodationCapacity) {
    throw requestError('NO_ACCOMMODATION_SEAT', `No accommodation seat left on session ${sessionId}`, 50003);
  }

  const st = currentState();
  const status = seatsHeld(session) < session.capacity ? 'BOOKED' : 'WAITLISTED';
  const booking = { bookingId: st.nextBookingId, candidateNumber, accommodationCode, status, bookedAt: Date.now(), createdAt: nowIso() };
  st.nextBookingId += 1;
  if (status === 'WAITLISTED') {
    const last = waitlisted(session).pop();
    booking.waitlistPosition = last ? last.waitlistPosition + 1 : 1;
    booking.addedAt = booking.createdAt;
  }
  session.bookings.push(booking);
  touch();

  incrementMetric('scheduling_service.booking.created', { service: SERVICE, status: status.toLowerCase() });
  logger.info('Booking created', { bookingId: booking.bookingId, sessionId, status, service: SERVICE, route: BOOKINGS_ROUTE });
  return {
    bookingId: booking.bookingId,
    status,
    sessionId,
    candidateNumber,
    accommodationCode,
    channel: 'PORTAL',
    waitlistPosition: booking.waitlistPosition || null,
    seatsAvailable: sessionView(session).seatsAvailable,
  };
}

/** GET /api/v2/candidates/{candidateNumber}/bookings (seeded waitlist entries and bookings made on this demo page). */
function candidateBookings(data = {}) {
  const candidateNumber = typeof data.candidateNumber === 'string' ? data.candidateNumber.trim().toUpperCase() : '';
  if (!/^NW\d{8}$/.test(candidateNumber)) throw requestError('VALIDATION', 'candidateNumber must be NW followed by 8 digits');
  const out = [];
  for (const session of currentState().sessions.values()) {
    for (const b of session.bookings) {
      if (b.candidateNumber !== candidateNumber) continue;
      out.push({
        bookingId: b.bookingId,
        sessionId: session.sessionId,
        candidateNumber,
        examCode: session.examCode,
        sessionStartsAt: session.startsAt,
        status: b.status,
        accommodationCode: b.accommodationCode,
        channel: 'PORTAL',
        bookedAt: b.createdAt || b.addedAt,
        waitlistPosition: b.status === 'WAITLISTED' ? b.waitlistPosition : null,
      });
    }
  }
  return out.sort((a, b) => a.sessionStartsAt.localeCompare(b.sessionStartsAt));
}

/**
 * PUT /api/v2/sessions/{sessionId}/capacity on scheduling-service, body
 * {"newCapacity","actor"}. A decrease below the seats held moves the newest
 * BOOKED bookings to the waitlist (legacy trg_ExamSession_Update); accepted
 * changes are relayed to the legacy tables through the outbox.
 */
function changeCapacity(data = {}) {
  const startedAt = Date.now();
  const sessionId = parseSessionId(data.sessionId);
  const newCapacity = toInteger(data.newCapacity);
  if (typeof data.newCapacity === 'number' && Number.isInteger(data.newCapacity) && data.newCapacity < 0) {
    throw requestError('VALIDATION', 'newCapacity must be zero or more', 50005);
  }
  if (!Number.isInteger(newCapacity) || newCapacity > MAX_CAPACITY) {
    throw requestError('VALIDATION', `newCapacity must be a whole number between 0 and ${MAX_CAPACITY}`);
  }
  const session = findSession(sessionId);
  const used = accommodationUsed(session);

  if (session.accommodationCapacity > 0) {
    const floor = session.accommodationCapacity + (seatsHeld(session) - used);
    if (newCapacity < floor) {
      incrementMetric('scheduling_service.capacity_change.rejected', { service: SERVICE, error: 'capacity_below_accommodation_floor' });
      recordTiming('scheduling_service.capacity_change.latency', Date.now() - startedAt, { service: SERVICE, route: CAPACITY_ROUTE, error: 'true' });
      logger.warn('Capacity change rejected', {
        sessionId, newCapacity, error: 'CAPACITY_BELOW_ACCOMMODATION_FLOOR', legacyCode: 50005, service: SERVICE, route: CAPACITY_ROUTE,
      });
      throw requestError('CAPACITY_BELOW_ACCOMMODATION_FLOOR', `New capacity ${newCapacity} is below the accommodation floor ${floor}`, 50005);
    }
  }

  const previousCapacity = session.capacity;
  session.capacity = newCapacity;
  const excess = seatsHeld(session) - newCapacity;
  const bumped = newCapacity < previousCapacity && excess > 0
    ? session.bookings
      .filter((b) => b.status === 'BOOKED')
      .sort((a, b) => (b.bookedAt - a.bookedAt) || (b.bookingId - a.bookingId))
      .slice(0, excess)
      .sort((a, b) => (a.bookedAt - b.bookedAt) || (a.bookingId - b.bookingId))
    : [];
  for (const b of bumped) {
    const last = waitlisted(session).pop();
    b.status = 'WAITLISTED';
    b.waitlistPosition = last ? last.waitlistPosition + 1 : 1;
    b.addedAt = nowIso();
  }
  touch();

  incrementMetric('scheduling_service.capacity_change.accepted', { service: SERVICE });
  recordTiming('scheduling_service.capacity_change.latency', Date.now() - startedAt, { service: SERVICE, route: CAPACITY_ROUTE });
  logger.info('Capacity changed', {
    sessionId, previousCapacity, newCapacity, bumped: bumped.length, actor: typeof data.actor === 'string' ? data.actor.slice(0, 80) : null, service: SERVICE, route: CAPACITY_ROUTE,
  });
  return {
    session: sessionView(session),
    bumpedBookingIds: bumped.map((b) => b.bookingId),
  };
}

module.exports = {
  referenceData,
  searchSessions,
  getSession,
  getWaitlist,
  bookSeat,
  candidateBookings,
  changeCapacity,
  resetState,
  CENTERS,
  EXAMS,
  ACCOMMODATION_CODES,
  STATE_TTL_MS,
};
