const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const ROUTE = '/api/oncall/evreservation/reservations';

/**
 * Configurator trims as published by the vehicle catalog. `buildCode` is the
 * production build the reservation is placed against.
 */
const TRIMS = {
  performance: { name: 'R2 Performance', buildCode: 'R2-PERF-LE', priceCents: 5799000 },
  premium: { name: 'R2 Premium', buildCode: 'R2-PREM', priceCents: 5399000 },
  standard: { name: 'R2 Standard', buildCode: 'R2-STD', priceCents: 4499000 },
};

/**
 * Refundable deposit schedule per production build, from the order-intake
 * pricing service.
 */
const DEPOSIT_SCHEDULES = {
  'R2-PERF': { amountCents: 10000, currency: 'USD', refundable: true, queue: 'DELIVERY' },
  'R2-PREM': { amountCents: 10000, currency: 'USD', refundable: true, queue: 'WAITLIST' },
  'R2-STD': { amountCents: 10000, currency: 'USD', refundable: true, queue: 'WAITLIST' },
};

/**
 * Place a refundable R2 reservation for the configured build.
 */
async function createReservation(request, options = {}) {
  const startTime = Date.now();
  const reservationId = uuidv4();
  const trimKey = String(request.trim || '').toLowerCase();

  logger.info('R2 reservation request', {
    reservationId, trim: trimKey, paint: request.paint, service: 'reservation-api', route: ROUTE,
  });

  try {
    const trim = TRIMS[trimKey];
    if (!trim) {
      const error = new Error(`Unknown trim: ${trimKey}`);
      error.code = 'INVALID_CONFIGURATION';
      throw error;
    }
    const schedule = DEPOSIT_SCHEDULES[trim.buildCode];
    const deposit = {
      amountCents: schedule.amountCents,
      currency: schedule.currency,
      refundable: schedule.refundable,
    };
    const duration = Date.now() - startTime;

    incrementMetric('evreservation.reservation.success', { route: ROUTE });
    recordTiming('evreservation.reservation.latency', duration, { route: ROUTE });

    return {
      success: true,
      reservationId,
      confirmationNumber: `R2-${reservationId.slice(0, 8).toUpperCase()}`,
      vehicle: trim.name,
      queue: schedule.queue,
      deposit,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('evreservation.reservation.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('evreservation.reservation.latency', duration, { route: ROUTE, error: 'true' });
    logger.error('R2 reservation failed', {
      reservationId, error: error.message, errorClass: error.name, code: error.code, durationMs: duration, trim: trimKey,
    });
    if (error.code !== 'INVALID_CONFIGURATION') {
      Sentry.captureException(error, {
        tags: { route: ROUTE, service: 'reservation-api', ...(options.synthetic ? { synthetic_probe: 'true' } : {}) },
        extra: { reservationId, trim: trimKey },
      });
    }
    throw error;
  }
}

module.exports = { createReservation, TRIMS, DEPOSIT_SCHEDULES };
