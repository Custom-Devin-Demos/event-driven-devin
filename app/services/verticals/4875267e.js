const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/4875267e/register';
const SERVICE = 'event-registration-api';

/**
 * Participation slots for the event, keyed by slot id. `method` mirrors the
 * organiser-side setting: first-come slots confirm on submit, lottery slots
 * confirm when the organiser draws.
 */
const SLOT_CONFIGS = {
  general: { label: '一般参加枠', capacity: 40, method: 'first-come', fee: 0, venue: 'onsite' },
  lt:      { label: 'LT 登壇枠（5分）', capacity: 5, method: 'first-come', fee: 0, venue: 'onsite' },
  online:  { label: 'オンライン参加枠', capacity: 100, method: 'first-come', fee: 0, venue: 'online' },
};

/**
 * Current registrations for the event (confirmed count per slot).
 */
const EVENT = {
  id: 'fukuoka-go-27',
  title: 'Fukuoka.go #27 - Go で学ぶ並行処理の基礎と実践',
  startsAt: '2026-11-13T19:00:00+09:00',
  registrations: { general: 31, lt: 4, online: 58 },
};

/**
 * Retrieve the slot configuration for a slot id, falling back to the general
 * slot for ids the organiser has since renamed.
 */
function getSlotConfig(slotId) {
  return SLOT_CONFIGS[slotId] || SLOT_CONFIGS.general;
}

/**
 * Allocate the attendee's place in the slot: a confirmed seat number while
 * capacity remains, otherwise a waitlist position.
 */
function allocateSeat(config, confirmed) {
  const remaining = config.capacity - confirmed;
  if (remaining > 0) {
    return {
      assigned: { number: confirmed + 1, status: 'confirmed', remaining: remaining - 1 },
    };
  }
  return {
    assigned: { number: null, status: 'waitlisted', position: confirmed - config.capacity + 1 },
  };
}

/**
 * Register an attendee for a participation slot.
 */
async function registerAttendee(data) {
  const startTime = Date.now();
  const registrationId = uuidv4();

  logger.info('Registering attendee', {
    registrationId,
    eventId: EVENT.id,
    slotId: data.slotId,
    displayName: data.displayName,
    service: SERVICE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 120));

    const config = getSlotConfig(data.slotId);
    const confirmed = EVENT.registrations[data.slotId] || 0;
    const seat = allocateSeat(config, confirmed);

    const duration = Date.now() - startTime;

    incrementMetric('registration.success', { route: ROUTE, slot: data.slotId });
    recordTiming('registration.latency', duration, { route: ROUTE });

    return {
      success: true,
      registrationId,
      eventId: EVENT.id,
      slotId: data.slotId,
      slotLabel: config.label,
      method: config.method,
      status: seat.allocation.status,
      seatNumber: seat.allocation.number,
      displayName: data.displayName,
      experience: data.experience,
      referral: data.referral,
      registeredAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('registration.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('registration.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Event registration failed', {
      registrationId,
      eventId: EVENT.id,
      slotId: data.slotId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, slot: data.slotId, alert_path: 'instant' },
      extra: { registrationId, eventId: EVENT.id, displayName: data.displayName },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/4875267e.js — registerAttendee',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Event Registration',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'alert_path', value: 'instant' },
      ],
      extra: { registrationId, eventId: EVENT.id, slotId: data.slotId, displayName: data.displayName },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'event-registration@2.4.1',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from registration error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { registerAttendee, SLOT_CONFIGS, EVENT };
