const crypto = require('crypto');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const APPOINTMENTS_ROUTE = '/api/oncall/examscheduling/appointments';
const SERVICE = 'vue-scheduling-api';

const EXAMS = [
  { code: 'MO-200', name: 'Microsoft Excel Associate (Microsoft 365 Apps)', provider: 'Certiport', priceGbp: 9900 },
  { code: 'MO-100', name: 'Microsoft Word Associate', provider: 'Certiport', priceGbp: 9900 },
  { code: 'IC3-GS6-L1', name: 'IC3 Digital Literacy GS6 Level 1', provider: 'Certiport', priceGbp: 6500 },
  { code: 'SY0-701', name: 'CompTIA Security+', provider: 'Pearson VUE', priceGbp: 33800 },
];

function londonDateParts(instant, includeTime = false) {
  const options = {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  };
  if (includeTime) Object.assign(options, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  return Object.fromEntries(new Intl.DateTimeFormat('en-GB', options)
    .formatToParts(instant)
    .map(({ type, value }) => [type, value]));
}

function londonUtcOffset(instant) {
  const parts = londonDateParts(instant, true);
  const londonWallTimeAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return londonWallTimeAsUtc - instant;
}

function londonWallTimeToUtc(year, month, day, hour, minute) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const firstResult = guess - londonUtcOffset(guess);
  return new Date(guess - londonUtcOffset(firstResult));
}

function slotsFor(centre, now = new Date()) {
  const today = londonDateParts(now);
  return centre.dayOffsets.flatMap((dayOffset) => {
    const calendarDate = new Date(Date.UTC(
      Number(today.year),
      Number(today.month) - 1,
      Number(today.day) + dayOffset,
    ));
    const date = londonDateParts(calendarDate);
    const year = Number(date.year);
    const month = Number(date.month);
    const day = Number(date.day);
    return centre.hours.map((hour) => {
      const minute = 0;
      const startsAt = londonWallTimeToUtc(year, month, day, hour, minute);
      const dateId = `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
      const timeId = `${String(hour).padStart(2, '0')}${String(minute).padStart(2, '0')}`;
      return {
        id: `${centre.id}-${dateId}-${timeId}`,
        startsAt: startsAt.toISOString(),
        status: 'available',
      };
    });
  });
}

const TEST_CENTRES = [
  {
    id: 'VUE-LON-01',
    name: 'London Bridge',
    address: '25 St Thomas Street',
    city: 'London',
    postcode: 'SE1 9RS',
    dayOffsets: [1, 2, 4],
    hours: [9, 13],
  },
  {
    id: 'VUE-MAN-01',
    name: 'Manchester Central',
    address: '6th Floor, City Tower, Piccadilly Plaza',
    city: 'Manchester',
    postcode: 'M1 4BT',
    dayOffsets: [1, 3, 5],
    hours: [10, 14],
  },
  {
    id: 'VUE-BHM-01',
    name: 'Birmingham New Street',
    address: '9 Brindley Place',
    city: 'Birmingham',
    postcode: 'B1 2HS',
    dayOffsets: [2, 3, 5],
    hours: [9, 12, 15],
  },
  {
    id: 'VUE-LDS-01',
    name: 'Leeds City Centre',
    address: 'Wellington Place',
    city: 'Leeds',
    postcode: 'LS1 4AP',
    dayOffsets: [1, 3, 6],
    hours: [10, 13],
  },
];

const SCHEDULING_STORES = [
  { id: 'US-Central', host: 'us-central.vts-scheduling.internal' },
  { id: 'EU-West', host: 'eu-west.vts-scheduling.internal' },
  { id: 'UK-South', host: 'uk-south.vts-scheduling.internal' },
  { id: 'ME-Central', host: 'me-central.vts-scheduling.internal' },
  { id: 'AP-Southeast', host: 'ap-southeast.vts-scheduling.internal' },
  { id: 'AU-East', host: 'au-east.vts-scheduling.internal' },
];

const RESIDENCY_REGIONS = {
  UK: 'UK-South',
  'US-Central': 'US-Central',
  'EU-West': 'EU-West',
  'UK-South': 'UK-South',
  'ME-Central': 'ME-Central',
  'AP-Southeast': 'AP-Southeast',
  'AU-East': 'AU-East',
};
const BOOKING_DEADLINE_MS = 9000;
const STORE_WRITE_LATENCY_MS = [1550, 1750];

const delay = ([minMs, maxMs]) => new Promise((resolve) => {
  setTimeout(resolve, minMs + Math.random() * (maxMs - minMs));
});

function invalidBooking(message) {
  const error = new Error(message);
  error.code = 'INVALID_BOOKING';
  return error;
}

function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Booking confirmation exceeded ${ms}ms`);
      error.code = 'BOOKING_TIMEOUT';
      reject(error);
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function getExam(examCode) {
  return EXAMS.find((exam) => exam.code === examCode);
}

function getTestCentre(testCentreId) {
  return TEST_CENTRES.find((centre) => centre.id === testCentreId);
}

function getAvailability({ examCode } = {}, now = new Date()) {
  const exam = getExam(examCode);
  if (!exam) throw invalidBooking('Select a valid exam.');
  return {
    success: true,
    exam: { ...exam },
    testCentres: TEST_CENTRES.map((centre) => ({
      id: centre.id,
      name: centre.name,
      address: centre.address,
      city: centre.city,
      postcode: centre.postcode,
      slots: slotsFor(centre, now),
    })),
  };
}

function validateBooking(data = {}, now = new Date()) {
  const exam = getExam(data.examCode);
  if (!exam) throw invalidBooking('Select a valid exam.');

  const testCentre = getTestCentre(data.testCentreId);
  if (!testCentre) throw invalidBooking('Select a valid test centre.');

  const londonToday = londonDateParts(now);
  const maxOffset = Math.max(...testCentre.dayOffsets);
  let slot = null;
  for (let k = 0; k <= maxOffset && !slot; k += 1) {
    const candidate = slotsFor(testCentre, new Date(now.getTime() - k * 86400000))
      .find((availableSlot) => availableSlot.id === data.slotId) || null;
    if (!candidate) continue;

    const candidateDate = londonDateParts(new Date(candidate.startsAt));
    const isToday = candidateDate.year === londonToday.year
      && candidateDate.month === londonToday.month
      && candidateDate.day === londonToday.day;
    if (k === 0 || isToday) slot = candidate;
  }

  if (!slot) throw invalidBooking('Select an available slot at this test centre.');
  if (new Date(slot.startsAt) <= now) {
    throw invalidBooking('That slot is no longer available. Search again.');
  }

  const candidate = data.candidate && typeof data.candidate === 'object' ? data.candidate : {};
  const firstName = typeof candidate.firstName === 'string' ? candidate.firstName.trim() : '';
  const lastName = typeof candidate.lastName === 'string' ? candidate.lastName.trim() : '';
  const email = typeof candidate.email === 'string' ? candidate.email.trim() : '';
  const candidateId = typeof candidate.candidateId === 'string' ? candidate.candidateId.trim() : '';
  if (!firstName || !lastName || !candidateId) throw invalidBooking('Candidate details are required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalidBooking('Enter a valid email address.');

  const residencyRegion = data.residencyRegion;
  if (!Object.hasOwn(RESIDENCY_REGIONS, residencyRegion)) throw invalidBooking('Select a valid residency region.');

  return {
    exam,
    testCentre,
    slot,
    candidate: { firstName, lastName, email, candidateId },
    residencyRegion,
  };
}

async function writeAppointmentToStore(store, appointmentId) {
  await delay(STORE_WRITE_LATENCY_MS);
  return { store: store.id, appointmentId };
}

async function syncAcrossRegions(appointmentId, deadlineAt) {
  const writes = [];
  for (const store of SCHEDULING_STORES) {
    const startedAt = Date.now();
    try {
      const write = await withDeadline(writeAppointmentToStore(store, appointmentId), Math.max(0, deadlineAt - startedAt));
      logger.info('Regional scheduling-store write', {
        appointmentId,
        region: store.id,
        host: store.host,
        durationMs: Date.now() - startedAt,
        service: SERVICE,
        route: APPOINTMENTS_ROUTE,
      });
      writes.push(write);
    } catch (error) {
      logger.info('Regional scheduling-store write', {
        appointmentId,
        region: store.id,
        host: store.host,
        durationMs: Date.now() - startedAt,
        writeStatus: error.code === 'BOOKING_TIMEOUT' ? 'timed_out' : 'failed',
        service: SERVICE,
        route: APPOINTMENTS_ROUTE,
      });
      throw error;
    }
  }
  return writes;
}

async function confirmBooking(data = {}, now = new Date()) {
  const startedAt = Date.now();
  const booking = validateBooking(data, now);
  const appointmentId = `VUE-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

  try {
    const writes = await syncAcrossRegions(appointmentId, startedAt + BOOKING_DEADLINE_MS);
    const durationMs = Date.now() - startedAt;
    incrementMetric('examscheduling.booking.confirm.success', { route: APPOINTMENTS_ROUTE });
    recordTiming('examscheduling.booking.confirm.latency', durationMs, { route: APPOINTMENTS_ROUTE, service: SERVICE });
    return {
      success: true,
      appointment: {
        id: appointmentId,
        confirmationNumber: appointmentId,
        exam: { ...booking.exam },
        testCentre: {
          id: booking.testCentre.id,
          name: booking.testCentre.name,
          city: booking.testCentre.city,
        },
        startsAt: booking.slot.startsAt,
        priceGbp: booking.exam.priceGbp,
        residencyRegion: booking.residencyRegion,
      },
      regionsSynced: writes.length,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    if (error.code === 'INVALID_BOOKING') throw error;

    incrementMetric('examscheduling.booking.confirm.failure', { route: APPOINTMENTS_ROUTE, errorClass: error.name });
    recordTiming('examscheduling.booking.confirm.latency', durationMs, {
      route: APPOINTMENTS_ROUTE,
      service: SERVICE,
      error: 'true',
    });
    logger.error('Booking confirmation failed', {
      appointmentId,
      error: error.message,
      errorClass: error.name,
      code: error.code,
      durationMs,
      service: SERVICE,
      route: APPOINTMENTS_ROUTE,
    });
    Sentry.captureException(error, {
      tags: { route: APPOINTMENTS_ROUTE, service: SERVICE },
      extra: { appointmentId, examCode: booking.exam.code, testCentreId: booking.testCentre.id },
    });
    throw error;
  }
}

module.exports = {
  getAvailability,
  slotsFor,
  confirmBooking,
  EXAMS,
  TEST_CENTRES,
  SCHEDULING_STORES,
  BOOKING_DEADLINE_MS,
  STORE_WRITE_LATENCY_MS,
  syncAcrossRegions,
};
