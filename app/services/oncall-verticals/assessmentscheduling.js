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
  { code: 'CTA-SEC2', title: 'Security Operations Associate', durationMinutes: 120 },
  { code: 'BCB-PM100', title: 'Project Management Practitioner', durationMinutes: 180 },
  { code: 'MHL-PHT', title: 'Pharmacy Technician Certificate', durationMinutes: 120 },
];

const TEST_CENTRES = [
  { code: 'BOS01', name: 'Harborview Testing Centre', city: 'Boston', timeZone: 'America/New_York' },
  { code: 'NYC02', name: 'Midtown Assessment Suites', city: 'New York', timeZone: 'America/New_York' },
  { code: 'ATL01', name: 'Peachtree Exam Centre', city: 'Atlanta', timeZone: 'America/New_York' },
  { code: 'DEN01', name: 'Front Range Exam Centre', city: 'Denver', timeZone: 'America/Denver' },
];

const ACCOMMODATION_CODES = ['ET25', 'ET50', 'SR', 'RB'];
// Extra-time codes need an accommodation-capable seat; SR and RB do not.
const SEATED_ACCOMMODATIONS = new Set(['ET25', 'ET50']);

// [sessionId, centre, exam, dayOffset, startTime, room, capacity, accommodationCapacity, booked, accommodationBooked, note]
const SEED = [
  [41871, 'BOS01', 'BCB-PM100', 2, '08:30', 'Room A', 24, 0, 15, 0, null],
  [41872, 'BOS01', 'CTA-SEC2', 2, '08:30', 'Room B', 30, 4, 22, 0, '6 workstations out of service'],
  [41873, 'BOS01', 'MHL-PHT', 2, '13:00', 'Room A', 24, 2, 9, 1, null],
  [41874, 'BOS01', 'CTA-SEC2', 4, '08:30', 'Room B', 30, 4, 18, 2, null],
  [41875, 'BOS01', 'BCB-PM100', 6, '13:00', 'Room A', 24, 0, 24, 0, null],
  [41876, 'BOS01', 'MHL-PHT', 9, '08:30', 'Room B', 30, 4, 6, 0, null],
  [52310, 'NYC02', 'CTA-SEC2', 1, '09:00', 'Suite 4', 30, 3, 20, 1, null],
  [52311, 'NYC02', 'BCB-PM100', 3, '09:00', 'Suite 5', 16, 0, 11, 0, null],
  [52312, 'NYC02', 'MHL-PHT', 5, '13:30', 'Suite 4', 30, 3, 14, 2, null],
  [52313, 'NYC02', 'CTA-SEC2', 8, '09:00', 'Quiet Room', 8, 2, 3, 0, null],
  [60218, 'ATL01', 'BCB-PM100', 1, '08:00', 'Room 1', 18, 0, 12, 0, null],
  [60219, 'ATL01', 'CTA-SEC2', 3, '12:30', 'Room 2', 26, 3, 19, 1, null],
  [60220, 'ATL01', 'MHL-PHT', 6, '08:00', 'Room 1', 18, 2, 5, 0, null],
  [71402, 'DEN01', 'CTA-SEC2', 2, '09:30', 'Testing Lab', 15, 1, 12, 1, null],
  [71403, 'DEN01', 'BCB-PM100', 4, '09:30', 'Testing Lab', 15, 0, 8, 0, null],
  [71404, 'DEN01', 'MHL-PHT', 7, '13:00', 'Testing Lab', 15, 1, 3, 0, null],
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
    const bookings = [];
    for (let i = 0; i < booked; i += 1) {
      bookings.push({
        bookingId: id * 1000 + i + 1,
        candidateNumber: `NW${String(id * 100 + i).padStart(8, '0').slice(-8)}`,
        accommodationCode: i < accommodationBooked ? 'ET25' : null,
        status: 'BOOKED',
        bookedAt: now.getTime() - (booked - i) * 3600000,
      });
    }
    sessions.set(id, {
      sessionId: id,
      centerCode,
      examCode,
      date: isoDate(addDays(now, dayOffset)),
      startTime,
      room,
      capacity,
      accommodationCapacity,
      status: 'OPEN',
      note,
      bookings,
      nextWaitlistPosition: 1,
    });
  }
  return { sessions, nextBookingId: 900001 };
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

function sessionView(session) {
  const exam = EXAMS.find((e) => e.code === session.examCode);
  const centre = TEST_CENTRES.find((c) => c.code === session.centerCode);
  const booked = seatsHeld(session);
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
    booked,
    accommodationUsed: accommodationUsed(session),
    seatsAvailable: Math.max(0, session.capacity - booked),
    waitlistCount: session.bookings.filter((b) => b.status === 'WAITLISTED').length,
    status: session.status,
    note: session.note,
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
  if (!session) throw requestError('SESSION_NOT_FOUND', `Session ${sessionId} not found.`);
  return session;
}

function parseDate(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw requestError('VALIDATION', 'Dates must be yyyy-MM-dd');
  }
  return value;
}

/**
 * GET /api/v2/centers/{centerCode}/sessions?examCode=&from=&to= on scheduling-service.
 */
function searchSessions(query = {}, now = new Date()) {
  const startedAt = Date.now();
  const centre = TEST_CENTRES.find((c) => c.code === query.centerCode);
  if (!centre) throw requestError('CENTER_NOT_FOUND', `Test center ${query.centerCode} not found`);
  const examCode = query.examCode || null;
  if (examCode && !EXAMS.some((e) => e.code === examCode)) throw requestError('VALIDATION', 'Unknown examCode');
  const from = parseDate(query.from, isoDate(now));
  const to = parseDate(query.to, isoDate(addDays(now, 14)));
  if (to < from) throw requestError('VALIDATION', 'to must be on or after from');
  if (Date.parse(to) - Date.parse(from) > SEARCH_WINDOW_DAYS * 86400000) {
    throw requestError('VALIDATION', `Search at most ${SEARCH_WINDOW_DAYS} days at a time`);
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
    throw requestError('SESSION_NOT_OPEN', `Session ${sessionId} is not open for booking (status ${session.status})`, 50001);
  }
  if (session.bookings.some((b) => b.candidateNumber === candidateNumber && (held(b) || b.status === 'WAITLISTED'))) {
    throw requestError('DUPLICATE_BOOKING', `Candidate already has an active booking on session ${sessionId}`, 50002);
  }
  const seated = accommodationCode && SEATED_ACCOMMODATIONS.has(accommodationCode);
  if (seated && accommodationUsed(session) >= session.accommodationCapacity) {
    throw requestError('NO_ACCOMMODATION_SEAT', `No accommodation seat available on session ${sessionId}`, 50003);
  }

  const st = currentState();
  const status = seatsHeld(session) < session.capacity ? 'BOOKED' : 'WAITLISTED';
  const booking = { bookingId: st.nextBookingId, candidateNumber, accommodationCode, status, bookedAt: Date.now() };
  st.nextBookingId += 1;
  if (status === 'WAITLISTED') {
    booking.waitlistPosition = session.nextWaitlistPosition;
    session.nextWaitlistPosition += 1;
  }
  session.bookings.push(booking);
  touch();

  incrementMetric('scheduling_service.booking.created', { service: SERVICE, status: status.toLowerCase() });
  logger.info('Booking created', { bookingId: booking.bookingId, sessionId, status, service: SERVICE, route: BOOKINGS_ROUTE });
  return {
    success: true,
    booking: {
      bookingId: booking.bookingId,
      sessionId,
      candidateNumber,
      accommodationCode,
      status,
      waitlistPosition: booking.waitlistPosition || null,
      channel: 'PORTAL',
    },
    session: sessionView(session),
  };
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

  if (session.accommodationCapacity > 0) {
    const standardHeld = session.bookings.filter((b) => held(b) && !SEATED_ACCOMMODATIONS.has(b.accommodationCode)).length;
    const floor = session.accommodationCapacity + standardHeld;
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
    b.status = 'WAITLISTED';
    b.waitlistPosition = session.nextWaitlistPosition;
    session.nextWaitlistPosition += 1;
  }
  if (typeof data.reason === 'string' && data.reason.trim()) session.note = data.reason.trim().slice(0, 120);
  touch();

  incrementMetric('scheduling_service.capacity_change.accepted', { service: SERVICE });
  recordTiming('scheduling_service.capacity_change.latency', Date.now() - startedAt, { service: SERVICE, route: CAPACITY_ROUTE });
  logger.info('Capacity changed', {
    sessionId, previousCapacity, newCapacity, bumped: bumped.length, actor: typeof data.actor === 'string' ? data.actor.slice(0, 80) : null, service: SERVICE, route: CAPACITY_ROUTE,
  });
  return {
    success: true,
    previousCapacity,
    session: sessionView(session),
    bumpedBookingIds: bumped.map((b) => b.bookingId),
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
