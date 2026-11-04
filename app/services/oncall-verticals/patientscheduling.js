const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const ROUTE = '/api/oncall/patientscheduling/appointments';
const SERVICE = 'scheduling-api';
const TIME_ZONE = 'America/New_York';
const BOOKING_WINDOW_DAYS = 5;

const VISIT_TYPES = {
  'facial-consult': { name: 'Facial rejuvenation consultation', minutes: 45 },
  'breast-consult': { name: 'Breast consultation', minutes: 60 },
  'body-consult': { name: 'Body contouring consultation', minutes: 60 },
  'injectables-consult': { name: 'Injectables consultation', minutes: 30 },
};

const LOCATIONS = {
  'LOC-TPA-01': { name: 'Tampa · Westshore' },
  'LOC-STP-02': { name: 'St. Petersburg · Downtown' },
};

/**
 * Bookable providers. Open times come from each provider's calendar;
 * `scheduleId` points at the schedule template that booking rules are read from.
 */
const PROVIDERS = {
  'PRV-1042': { name: 'Dr. Elena Ruiz, MD', scheduleId: 'SCH-1042-V2', calendar: ['0830', '0915', '1045', '1130', '1300', '1415', '1530', '1615'] },
  'PRV-1077': { name: 'Dr. Marcus Hale, MD', scheduleId: 'SCH-1077', calendar: ['0800', '0930', '1100', '1330', '1445', '1600'] },
  'PRV-2015': { name: 'Jenna Brooks, PA-C', scheduleId: 'SCH-2015', calendar: ['0900', '0945', '1030', '1215', '1400', '1500', '1645'] },
};

/**
 * Schedule templates: the visit types a provider takes, where they practise
 * and the exam room a booked visit is assigned to.
 */
const SCHEDULE_TEMPLATES = {
  'SCH-1042': { visitTypes: ['facial-consult', 'breast-consult', 'body-consult', 'injectables-consult'], locations: ['LOC-TPA-01', 'LOC-STP-02'], room: 'Consult 2' },
  'SCH-1077': { visitTypes: ['facial-consult', 'breast-consult', 'body-consult'], locations: ['LOC-TPA-01', 'LOC-STP-02'], room: 'Consult 1' },
  'SCH-2015': { visitTypes: ['facial-consult', 'injectables-consult'], locations: ['LOC-TPA-01', 'LOC-STP-02'], room: 'Treatment 3' },
};

function invalidRequest(message) {
  const err = new Error(message);
  err.code = 'INVALID_BOOKING';
  return err;
}

function localDateParts(instant) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(instant).map((p) => [p.type, p.value]));
  return { id: `${parts.year}${parts.month}${parts.day}`, weekday: parts.weekday, month: Number(parts.month), day: Number(parts.day) };
}

function bookingDays(now = new Date()) {
  const days = [];
  for (let offset = 1; days.length < BOOKING_WINDOW_DAYS && offset < 14; offset += 1) {
    const d = localDateParts(new Date(now.getTime() + offset * 86400000));
    if (d.weekday !== 'Sat' && d.weekday !== 'Sun') days.push(d);
  }
  return days;
}

function timeLabel(hhmm) {
  const h = Number(hhmm.slice(0, 2));
  const m = hhmm.slice(2);
  return `${h % 12 || 12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
}

function getProvider(providerId) {
  return Object.hasOwn(PROVIDERS, String(providerId || '')) ? PROVIDERS[providerId] : null;
}

/**
 * Open times for a provider at a location over the booking window.
 */
function getAvailability({ providerId, locationId } = {}, now = new Date()) {
  const provider = getProvider(providerId);
  if (!provider) throw invalidRequest('Choose a provider.');
  if (!Object.hasOwn(LOCATIONS, String(locationId || ''))) throw invalidRequest('Choose a location.');
  return {
    success: true,
    provider: { id: providerId, name: provider.name },
    location: { id: locationId, name: LOCATIONS[locationId].name },
    timeZone: TIME_ZONE,
    days: bookingDays(now).map((d) => ({
      date: d.id,
      weekday: d.weekday,
      month: d.month,
      day: d.day,
      slots: provider.calendar.map((t) => ({ id: `${providerId}-${d.id}-${t}`, label: timeLabel(t) })),
    })),
  };
}

function resolveSlot(providerId, provider, slotId, now) {
  const match = /^(PRV-\d{4})-(\d{8})-(\d{4})$/.exec(String(slotId || ''));
  if (!match || match[1] !== providerId) throw invalidRequest('Choose an available time.');
  const day = bookingDays(now).find((d) => d.id === match[2]);
  if (!day || !provider.calendar.includes(match[3])) throw invalidRequest('That time is outside the booking window. Choose another time.');
  return { date: day, time: timeLabel(match[3]) };
}

/**
 * Book an open time with a provider.
 */
async function bookAppointment(request = {}, now = new Date()) {
  const startTime = Date.now();
  const appointmentId = uuidv4();
  const providerId = String(request.providerId || '');
  const visitTypeId = String(request.visitType || '');
  const locationId = String(request.locationId || '');

  logger.info('Appointment booking started', {
    appointmentId, providerId, visitType: visitTypeId, locationId, service: SERVICE, route: ROUTE,
  });

  try {
    const provider = getProvider(providerId);
    if (!provider) throw invalidRequest('Choose a provider.');
    if (!Object.hasOwn(VISIT_TYPES, visitTypeId)) throw invalidRequest('Choose a visit type.');
    if (!Object.hasOwn(LOCATIONS, locationId)) throw invalidRequest('Choose a location.');
    const slot = resolveSlot(providerId, provider, request.slotId, now);

    const template = SCHEDULE_TEMPLATES[provider.scheduleId];
    if (!template.visitTypes.includes(visitTypeId)) {
      throw invalidRequest(`${provider.name} doesn't offer this visit type online. Choose another provider.`);
    }
    if (!template.locations.includes(locationId)) {
      throw invalidRequest(`${provider.name} doesn't see patients at this location.`);
    }

    const duration = Date.now() - startTime;
    incrementMetric('scheduling.booking.success', { route: ROUTE });
    recordTiming('scheduling.booking.latency', duration, { route: ROUTE });

    return {
      success: true,
      appointmentId,
      confirmationNumber: `APT-${appointmentId.slice(0, 8).toUpperCase()}`,
      provider: provider.name,
      visitType: VISIT_TYPES[visitTypeId].name,
      location: LOCATIONS[locationId].name,
      date: slot.date.id,
      time: slot.time,
      room: template.room,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('scheduling.booking.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('scheduling.booking.latency', duration, { route: ROUTE, error: 'true' });
    logger.error('Appointment booking failed', {
      appointmentId, error: error.message, errorClass: error.name, code: error.code, durationMs: duration, providerId, service: SERVICE,
    });
    if (error.code !== 'INVALID_BOOKING') {
      Sentry.captureException(error, {
        tags: { route: ROUTE, service: SERVICE },
        extra: { appointmentId, providerId, visitType: visitTypeId },
      });
    }
    throw error;
  }
}

module.exports = { getAvailability, bookAppointment, PROVIDERS, SCHEDULE_TEMPLATES, VISIT_TYPES, LOCATIONS };
