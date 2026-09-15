/**
 * NOC event consumer for the Lumen outage notification service.
 *
 * Ingest is a read-only adapter (yd4-design): POST /api/b6894861/noc/events is
 * the demo stand-in for the stream subscription; the real subscriber would call
 * processEvent() from a Kafka/SNS consumer. Nothing writes back to the stream.
 */

const logger = require('../../telemetry/logger');
const datadog = require('../../telemetry/datadog');
const { applyEvent } = require('./rules');

const BACKFILL_AGE_MS = 60 * 60 * 1000;
const VALID_STATES = new Set(['down', 'degraded', 'restored']);

const processedEventIds = new Set();

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.code = 'VALIDATION_ERROR';
  }
}

function isIsoDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/**
 * Validate and normalize a raw NOC stream record.
 * @throws {ValidationError} with .code 'VALIDATION_ERROR' on any schema breach.
 */
function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('Event must be an object');
  }
  for (const field of ['eventId', 'incidentId', 'circuitId']) {
    if (typeof raw[field] !== 'string' || raw[field].trim() === '') {
      throw new ValidationError(`Event ${field} must be a non-empty string`);
    }
  }
  if (!VALID_STATES.has(raw.state)) {
    throw new ValidationError(`Event state must be one of: ${[...VALID_STATES].join(', ')}`);
  }
  if (!isIsoDate(raw.timestamp)) {
    throw new ValidationError('Event timestamp must be an ISO 8601 date-time');
  }
  if (raw.eta !== undefined && raw.eta !== null && !isIsoDate(raw.eta)) {
    throw new ValidationError('Event eta must be an ISO 8601 date-time or null');
  }
  if (raw.impact !== undefined && raw.impact !== null && typeof raw.impact !== 'string') {
    throw new ValidationError('Event impact must be a string');
  }
  if (raw.maintenance !== undefined && typeof raw.maintenance !== 'boolean') {
    throw new ValidationError('Event maintenance must be a boolean');
  }

  const event = {
    eventId: raw.eventId,
    incidentId: raw.incidentId,
    circuitId: raw.circuitId,
    state: raw.state,
    timestamp: new Date(raw.timestamp).toISOString(),
    maintenance: raw.maintenance === true,
  };
  if (Object.hasOwn(raw, 'eta')) event.eta = raw.eta ? new Date(raw.eta).toISOString() : null;
  if (raw.impact !== undefined && raw.impact !== null) event.impact = raw.impact;
  return event;
}

/**
 * Single entry point for NOC events. Idempotent on eventId.
 * @returns {{ eventId: string, outcome: string, incidentId: string,
 *   notificationsQueued: number, suppressed: Array }}
 *   outcome: processed | duplicate-event | maintenance-ignored |
 *            unresolved-circuit | backfilled
 */
function processEvent(rawEvent, { now = Date.now() } = {}) {
  const event = normalizeEvent(rawEvent);

  if (processedEventIds.has(event.eventId)) {
    return {
      eventId: event.eventId,
      outcome: 'duplicate-event',
      incidentId: event.incidentId,
      notificationsQueued: 0,
      suppressed: [],
    };
  }
  processedEventIds.add(event.eventId);

  // D5: maintenance-flagged events create no incident and no notification.
  if (event.maintenance) {
    logger.info('noc maintenance event ignored', {
      eventId: event.eventId,
      circuitId: event.circuitId,
    });
    datadog.incrementMetric('outage.events.processed', { outcome: 'maintenance-ignored' });
    return {
      eventId: event.eventId,
      outcome: 'maintenance-ignored',
      incidentId: event.incidentId,
      notificationsQueued: 0,
      suppressed: [],
    };
  }

  // AC-14: events older than 60 minutes update portal state only (backfilled).
  const backfilled = now - new Date(event.timestamp).getTime() > BACKFILL_AGE_MS;

  const result = applyEvent(event, { now, backfilled });
  datadog.incrementMetric('outage.events.processed', { outcome: result.outcome });
  return {
    eventId: event.eventId,
    outcome: result.outcome,
    incidentId: result.incidentId,
    notificationsQueued: result.notificationsQueued,
    suppressed: result.suppressed,
  };
}

function resetProcessedEvents() {
  processedEventIds.clear();
}

module.exports = {
  ValidationError,
  normalizeEvent,
  processEvent,
  resetProcessedEvents,
  BACKFILL_AGE_MS,
};
