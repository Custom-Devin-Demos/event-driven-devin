const crypto = require('crypto');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');

const SERVICE = 'scheduling-service';
const SEARCH_ROUTE = '/api/oncall/assessmentscheduling/sessions/search';
const BOOKINGS_ROUTE = '/api/oncall/assessmentscheduling/bookings';
const CAPACITY_ROUTE = '/api/oncall/assessmentscheduling/sessions/capacity';

// Demo state is shared by everyone presenting the page; it returns to the seed
// after a quiet spell so the next demo starts from the same numbers.
const STATE_TTL_MS = 30 * 60 * 1000;
const MAX_CAPACITY = 200;
const SEARCH_WINDOW_DAYS = 31;

const EXAMS = [
  { code: 'NWA-NET-310', title: 'Network Operations Professional', durationMinutes: 150 },
  { code: 'NWA-PM-210', title: 'Project Coordination Associate', durationMinutes: 120 },
  { code: 'NWA-CLN-120', title: 'Clinical Data Specialist', durationMinutes: 105 },
];

const TEST_CENTRES = [
  { code: 'NW-CHI-01', name: 'Chicago Loop', city: 'Chicago, IL', timeZone: 'America/Chicago' },
  { code: 'NW-DAL-02', name: 'Dallas North', city: 'Dallas, TX', timeZone: 'America/Chicago' },
  { code: 'NW-ATL-01', name: 'Atlanta Midtown', city: 'Atlanta, GA', timeZone: 'America/New_York' },
  { code: 'NW-DEN-01', name: 'Denver Tech Center', city: 'Greenwood Village, CO', timeZone: 'America/Denver' },
];

const ACCOMMODATION_CODES = ['ET25', 'ET50', 'SR', 'RB'];
// Extra-time codes need an accommodation-capable seat; SR and RB do not.
const SEATED_ACCOMMODATIONS = new Set(['ET25', 'ET50']);

// [sessionId, centre, exam, dayOffset, startTime, room, capacity, accommodationCapacity, booked, accommodationBooked, note]
const SEED = [
  [41871, 'NW-CHI-01', 'NWA-PM-210', 2, '08:30', 'Room A', 24, 0, 15, 0, null],
  [41872, 'NW-CHI-01', 'NWA-NET-310', 2, '08:30', 'Room B', 30, 4, 22, 3, 'Room B: 6 workstations out of service'],
  [41873, 'NW-CHI-01', 'NWA-CLN-120', 2, '13:00', 'Room A', 24, 2, 9, 1, null],
  [41874, 'NW-CHI-01', 'NWA-NET-310', 4, '08:30', 'Room B', 30, 4, 18, 2, null],
  [41875, 'NW-CHI-01', 'NWA-PM-210', 6, '13:00', 'Room A', 24, 0, 24, 0, null],
  [41876, 'NW-CHI-01', 'NWA-CLN-120', 9, '08:30', 'Room B', 30, 4, 6, 0, null],
  [52310, 'NW-DAL-02', 'NWA-NET-310', 1, '09:00', 'Lab 1', 28, 4, 20, 1, null],
  [52311, 'NW-DAL-02', 'NWA-PM-210', 3, '09:00', 'Lab 2', 20, 0, 11, 0, null],
  [52312, 'NW-DAL-02', 'NWA-CLN-120', 5, '13:30', 'Lab 1', 28, 2, 14, 2, null],
  [52313, 'NW-DAL-02', 'NWA-NET-310', 8, '09:00', 'Lab 1', 28, 4, 7, 0, null],
  [60218, 'NW-ATL-01', 'NWA-PM-210', 1, '08:00', 'Suite 3', 18, 0, 12, 0, null],
  [60219, 'NW-ATL-01', 'NWA-NET-310', 3, '12:30', 'Suite 4', 26, 3, 19, 1, null],
  [60220, 'NW-ATL-01', 'NWA-CLN-120', 6, '08:00', 'Suite 3', 18, 2, 5, 0, null],
  [71402, 'NW-DEN-01', 'NWA-NET-310', 2, '09:30', 'Room 1', 22, 2, 16, 1, null],
  [71403, 'NW-DEN-01', 'NWA-PM-210', 4, '09:30', 'Room 2', 16, 0, 8, 0, null],
  [71404, 'NW-DEN-01', 'NWA-CLN-120', 7, '13:00', 'Room 1', 22, 2, 3, 0, null],
];

let state = null;
let lastMutationAt = 0;
let seededDay = null;

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

function seedState(now = new Date()) {
  const sessions = new Map();
  for (const [id, centerCode, examCode, dayOffset, startTime, room, capacity, accommodationCapacity, booked, accommodationBooked, note] of SEED) {
    sessions.set(id, {
      sessionId: id,
      centerCode,
      examCode,
      date: isoDate(addDays(now, dayOffset)),
      startTime,
      room,
      capacity,
      accommodationCapacity,
      booked,
      accommodationBooked,
      status: 'OPEN',
      note,
      candidates: new Set(),
    });
  }
  return { sessions, bookings: [] };
}

// Reseed after 30 min without a change, or on a new day if nothing changed,
// so the seeded session dates stay relative to today.
function currentState(now = Date.now()) {
  const today = isoDate(new Date(now));
  const stale = lastMutationAt ? now - lastMutationAt > STATE_TTL_MS : seededDay !== today;
  if (!state || stale) {
    state = seedState(new Date(now));
    lastMutationAt = 0;
    seededDay = today;
  }
  return state;
}

function touch() {
  lastMutationAt = Date.now();
}

function resetState() {
  state = null;
  lastMutationAt = 0;
  seededDay = null;
}

function requestError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sessionView(session) {
  const exam = EXAMS.find((e) => e.code === session.examCode);
  const centre = TEST_CENTRES.find((c) => c.code === session.centerCode);
  return {
    sessionId: session.sessionId,
    examCode: session.examCode,
    examTitle: exam.title,
    centerCode: session.centerCode,
    centerName: centre.name,
    timeZone: centre.timeZone,
    room: session.room,
    date: session.date,
    startTime: session.startTime,
    capacity: session.capacity,
    accommodationCapacity: session.accommodationCapacity,
    booked: session.booked,
    accommodationBooked: session.accommodationBooked,
    seatsAvailable: Math.max(0, session.capacity - session.booked),
    status: session.status,
    note: session.note,
  };
}

function parseSessionId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw requestError('INVALID_REQUEST', 'sessionId must be a positive integer.');
  return id;
}

function findSession(sessionId) {
  const session = currentState().sessions.get(sessionId);
  if (!session) throw requestError('SESSION_NOT_FOUND', `Session ${sessionId} not found.`);
  return session;
}

function parseDate(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw requestError('INVALID_REQUEST', 'Dates must be yyyy-MM-dd.');
  }
  return value;
}

/**
 * GET /api/v1/sessions?centerCode=&examCode=&from=&to= on scheduling-service.
 */
function searchSessions(query = {}, now = new Date()) {
  const startedAt = Date.now();
  const centre = TEST_CENTRES.find((c) => c.code === query.centerCode);
  if (!centre) throw requestError('CENTRE_NOT_FOUND', 'Select a valid test centre.');
  const examCode = query.examCode || null;
  if (examCode && !EXAMS.some((e) => e.code === examCode)) throw requestError('INVALID_REQUEST', 'Select a valid exam.');
  const from = parseDate(query.from, isoDate(now));
  const to = parseDate(query.to, isoDate(addDays(now, 14)));
  if (to < from) throw requestError('INVALID_REQUEST', 'The end date must be on or after the start date.');
  if (Date.parse(to) - Date.parse(from) > SEARCH_WINDOW_DAYS * 86400000) {
    throw requestError('INVALID_REQUEST', `Search at most ${SEARCH_WINDOW_DAYS} days at a time.`);
  }

  const sessions = [...currentState(now.getTime()).sessions.values()]
    .filter((s) => s.centerCode === centre.code && (!examCode || s.examCode === examCode) && s.date >= from && s.date <= to)
    .sort((a, b) => (a.date + a.startTime + a.room).localeCompare(b.date + b.startTime + b.room))
    .map(sessionView);

  recordTiming('scheduling_service.sessions.search.latency', Date.now() - startedAt, { service: SERVICE, route: SEARCH_ROUTE });
  return {
    success: true,
    centre: { ...centre },
    from,
    to,
    sessions,
  };
}

/**
 * POST /api/v1/bookings on scheduling-service: BOOKED, or WAITLISTED when the
 * session is full (same contract as the legacy usp_BookSeat).
 */
function bookSeat(data = {}) {
  const sessionId = parseSessionId(data.sessionId);
  const candidateNumber = typeof data.candidateNumber === 'string' ? data.candidateNumber.trim().toUpperCase() : '';
  if (!/^NW\d{8}$/.test(candidateNumber)) throw requestError('INVALID_REQUEST', 'Candidate number must be NW followed by 8 digits.');
  const accommodationCode = data.accommodationCode ? String(data.accommodationCode).toUpperCase() : null;
  if (accommodationCode && !ACCOMMODATION_CODES.includes(accommodationCode)) {
    throw requestError('INVALID_REQUEST', 'Accommodation code must be ET25, ET50, SR or RB.');
  }

  const session = findSession(sessionId);
  if (session.status !== 'OPEN') throw requestError('SESSION_NOT_OPEN', `Session ${sessionId} is not open for booking.`);
  if (session.candidates.has(candidateNumber)) {
    throw requestError('DUPLICATE_BOOKING', `Candidate ${candidateNumber} already holds a seat in session ${sessionId}.`);
  }
  const seated = accommodationCode && SEATED_ACCOMMODATIONS.has(accommodationCode);
  const full = session.booked >= session.capacity;
  if (seated && !full && session.accommodationBooked >= session.accommodationCapacity) {
    throw requestError('NO_ACCOMMODATION_SEAT', `No accommodation seat left in session ${sessionId} for ${accommodationCode}.`);
  }

  const status = full ? 'WAITLISTED' : 'BOOKED';
  const bookingId = `BK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  session.candidates.add(candidateNumber);
  if (status === 'BOOKED') {
    session.booked += 1;
    if (seated) session.accommodationBooked += 1;
  }
  currentState().bookings.push({ bookingId, sessionId, candidateNumber, accommodationCode, status });
  touch();

  incrementMetric('scheduling_service.booking.created', { service: SERVICE, status: status.toLowerCase() });
  logger.info('Booking created', { bookingId, sessionId, status, service: SERVICE, route: BOOKINGS_ROUTE });
  return {
    success: true,
    booking: { bookingId, sessionId, candidateNumber, accommodationCode, status, channel: 'PORTAL' },
    session: sessionView(session),
  };
}

/**
 * PUT /api/v1/sessions/{sessionId}/capacity on scheduling-service. Accepted
 * changes are published to the outbox that relays them to the legacy tables.
 */
function changeCapacity(data = {}) {
  const startedAt = Date.now();
  const sessionId = parseSessionId(data.sessionId);
  const capacity = Number(data.capacity);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) {
    throw requestError('INVALID_REQUEST', `Capacity must be a whole number between 1 and ${MAX_CAPACITY}.`);
  }
  const session = findSession(sessionId);
  if (session.status !== 'OPEN') throw requestError('SESSION_NOT_OPEN', `Session ${sessionId} is not open.`);

  const committedSeats = session.booked + session.accommodationCapacity;
  if (capacity < committedSeats) {
    incrementMetric('scheduling_service.capacity_change.rejected', { service: SERVICE, reason: 'capacity_below_committed' });
    recordTiming('scheduling_service.capacity_change.latency', Date.now() - startedAt, { service: SERVICE, route: CAPACITY_ROUTE, error: 'true' });
    logger.warn('Capacity change rejected', {
      sessionId, requestedCapacity: capacity, code: 'CAPACITY_BELOW_COMMITTED', service: SERVICE, route: CAPACITY_ROUTE,
    });
    throw requestError('CAPACITY_BELOW_COMMITTED', `Capacity ${capacity} is below committed seats (${committedSeats}) for session ${sessionId}`);
  }

  const previousCapacity = session.capacity;
  session.capacity = capacity;
  if (data.reason && typeof data.reason === 'string') session.note = data.reason.trim().slice(0, 120) || session.note;
  touch();

  incrementMetric('scheduling_service.capacity_change.accepted', { service: SERVICE });
  recordTiming('scheduling_service.capacity_change.latency', Date.now() - startedAt, { service: SERVICE, route: CAPACITY_ROUTE });
  logger.info('Capacity changed', { sessionId, previousCapacity, capacity, service: SERVICE, route: CAPACITY_ROUTE });
  return {
    success: true,
    previousCapacity,
    session: sessionView(session),
    outbox: { event: 'SessionCapacityChanged', status: 'QUEUED' },
  };
}

module.exports = {
  searchSessions,
  bookSeat,
  changeCapacity,
  resetState,
  EXAMS,
  TEST_CENTRES,
  ACCOMMODATION_CODES,
  STATE_TTL_MS,
};
