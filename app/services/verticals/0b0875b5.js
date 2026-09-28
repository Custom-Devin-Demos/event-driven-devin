const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { FORMULARY, indexLotsByNdc, findLot } = require('./0b0875b5-formulary');

const SERVICE = '0b0875b5-api';
const ROUTE = '/api/0b0875b5/schedule';
const SLOT_MINUTES = 15;
const SLOT_DAYS = 3;

const STORES = [
  {
    storeNumber: '10247',
    address: '1401 2nd Ave',
    city: 'New York',
    state: 'NY',
    zip: '10021',
    phone: '(212) 249-5062',
    pharmacyHours: { open: '09:00', close: '21:00' },
    immunizersOnDuty: 2,
    inventory: [
      { ndc: '49281-0426-50', formulation: 'IIV3-SD', onHand: 184 },
      { ndc: '19515-0816-52', formulation: 'IIV3-SD', onHand: 62 },
      { ndc: '49281-0126-65', formulation: 'HD-IIV3', onHand: 48 },
      { ndc: '70461-0025-03', formulation: 'aIIV3', onHand: 30 },
      { ndc: '42874-0126-10', formulation: 'RIV3', onHand: 26 },
    ],
    booked: ['09:15', '09:30', '10:45', '12:00', '12:15', '16:30', '17:45'],
  },
  {
    storeNumber: '2931',
    address: '1500 Lexington Ave',
    city: 'New York',
    state: 'NY',
    zip: '10029',
    phone: '(212) 876-4610',
    pharmacyHours: { open: '08:00', close: '20:00' },
    immunizersOnDuty: 1,
    inventory: [
      { ndc: '49281-0426-50', formulation: 'IIV3-SD', onHand: 96 },
      { ndc: '49281-0126-65', formulation: 'HD-IIV3', onHand: 22 },
      { ndc: '42874-0126-10', formulation: 'RIV3', onHand: 14 },
    ],
    booked: ['08:00', '08:15', '11:30', '14:00', '18:15'],
  },
  {
    storeNumber: '4418',
    address: '300 E 86th St',
    city: 'New York',
    state: 'NY',
    zip: '10028',
    phone: '(212) 534-1880',
    pharmacyHours: { open: '09:00', close: '19:00' },
    immunizersOnDuty: 1,
    inventory: [
      { ndc: '19515-0816-52', formulation: 'IIV3-SD', onHand: 71 },
      { ndc: '70461-0025-03', formulation: 'aIIV3', onHand: 18 },
    ],
    booked: ['09:00', '13:45', '15:00'],
  },
];

const COHORTS = [
  { code: 'adult-18-64', minAge: 18, maxAge: 64, formulations: ['IIV3-SD', 'RIV3'], label: 'Standard dose flu shot' },
  { code: 'senior-65-plus', minAge: 65, maxAge: 130, formulations: ['HD-IIV3', 'aIIV3', 'RIV3'], label: 'Senior dose flu shot' },
];

const DEFAULT_STORE = '10247';
const DEFAULT_PATIENT_AGE = 42;

const LOT_INDEX = indexLotsByNdc(FORMULARY);
const ATTEMPTS = [];

function currentStatus() {
  const failed = ATTEMPTS.filter((a) => a.outcome === 'failed').length;
  return {
    state: failed > 0 ? 'degraded' : 'standby',
    attempts: ATTEMPTS.length,
    failed,
    lastAttemptAt: ATTEMPTS.length ? ATTEMPTS[ATTEMPTS.length - 1].at : null,
  };
}

function findStore(storeNumber) {
  const store = STORES.find((s) => s.storeNumber === String(storeNumber || DEFAULT_STORE));
  if (!store) {
    const err = new Error(`Unknown store ${storeNumber}`);
    err.status = 404;
    throw err;
  }
  return store;
}

function cohortFor(ageYears) {
  const age = Number.isFinite(Number(ageYears)) ? Number(ageYears) : DEFAULT_PATIENT_AGE;
  return COHORTS.find((c) => age >= c.minAge && age <= c.maxAge) || COHORTS[0];
}

function stockedDoses(store, cohort) {
  return store.inventory
    .filter((row) => cohort.formulations.includes(row.formulation) && row.onHand > 0)
    .map((row) => {
      const lot = findLot(LOT_INDEX, row.ndc);
      return {
        ndc: row.ndc,
        formulation: row.formulation,
        product: lot.product,
        manufacturer: lot.manufacturer,
        lotNumber: lot.lotNumber,
        expiresOn: lot.expiresOn,
        onHand: row.onHand,
        cashPrice: lot.cashPrice,
      };
    });
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function toClock(minutes) {
  const h = String(Math.floor(minutes / 60)).padStart(2, '0');
  const m = String(minutes % 60).padStart(2, '0');
  return `${h}:${m}`;
}

function openSlots(store, from) {
  const days = [];
  const open = toMinutes(store.pharmacyHours.open);
  const close = toMinutes(store.pharmacyHours.close);
  for (let d = 0; d < SLOT_DAYS; d += 1) {
    const day = new Date(from.getTime() + d * 86400000).toISOString().slice(0, 10);
    const times = [];
    for (let t = open; t + SLOT_MINUTES <= close; t += SLOT_MINUTES) {
      const clock = toClock(t);
      if (!store.booked.includes(clock)) times.push(clock);
    }
    days.push({ date: day, times: times.slice(0, 12), capacity: store.immunizersOnDuty });
  }
  return days;
}

function formatAvailability(requestId, store, cohort, doses, slots) {
  const totalDoses = doses.reduce((sum, d) => sum + d.onHand, 0);
  return {
    success: true,
    requestId,
    store: {
      storeNumber: store.storeNumber,
      address: `${store.address}, ${store.city}, ${store.state} ${store.zip}`,
      phone: store.phone,
    },
    cohort: { code: cohort.code, label: cohort.label },
    vaccines: doses.map((d) => ({
      product: d.product,
      manufacturer: d.manufacturer,
      lotNumber: d.lotNumber,
      expiresOn: d.expiresOn,
      dosesAvailable: d.onHand,
      cashPrice: d.cashPrice,
    })),
    totalDoses,
    slots,
    status: currentStatus(),
  };
}

async function processFluAppointment(data = {}) {
  const requestId = uuidv4();
  const startTime = Date.now();
  const storeNumber = data.storeNumber || DEFAULT_STORE;

  logger.info('Flu shot availability requested', {
    requestId,
    storeNumber,
    source: data.source,
    service: SERVICE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 110));

    const store = findStore(storeNumber);
    const cohort = cohortFor(data.patientAge);
    const doses = stockedDoses(store, cohort);
    const slots = openSlots(store, new Date());
    const result = formatAvailability(requestId, store, cohort, doses, slots);

    ATTEMPTS.push({ requestId, storeNumber, outcome: 'ok', at: new Date().toISOString() });
    result.status = currentStatus();

    const duration = Date.now() - startTime;
    incrementMetric('immunization.schedule.success', { route: ROUTE, cohort: cohort.code });
    recordTiming('immunization.schedule.latency', duration, { route: ROUTE });
    logger.info('Flu shot availability returned', {
      requestId,
      storeNumber,
      vaccines: result.vaccines.length,
      totalDoses: result.totalDoses,
      duration,
      service: SERVICE,
    });

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    ATTEMPTS.push({ requestId, storeNumber, outcome: 'failed', error: error.message, at: new Date().toISOString() });

    incrementMetric('immunization.schedule.failure', { route: ROUTE, error: error.name });
    recordTiming('immunization.schedule.latency', duration, { route: ROUTE, outcome: 'error' });
    logger.error('Flu shot availability failed', {
      requestId,
      storeNumber,
      error: error.message,
      stack: error.stack,
      duration,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, alert_path: 'instant' },
      extra: { requestId, storeNumber, patientAge: data.patientAge },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/0b0875b5.js — processFluAppointment',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Pharmacy Immunizations — Flu Shot Scheduling',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'storeNumber', value: storeNumber },
      ],
      extra: {
        requestId,
        storeNumber,
        patientAge: data.patientAge,
        source: data.source,
        promptContext: `A patient clicked "Schedule your flu shot" on the flu shot landing page and the scheduler failed before any appointment times were shown. Store #${storeNumber} has flu vaccine on hand, but no availability could be returned, so every patient trying to book a flu shot at this store is blocked.`,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || '0b0875b5@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session', { error: err.message, service: SERVICE });
    });

    throw error;
  }
}

function getCatalog() {
  return {
    stores: STORES.map((s) => ({
      storeNumber: s.storeNumber,
      address: `${s.address}, ${s.city}, ${s.state} ${s.zip}`,
      phone: s.phone,
      pharmacyHours: s.pharmacyHours,
    })),
    cohorts: COHORTS.map((c) => ({ code: c.code, label: c.label })),
    vaccines: FORMULARY.map((f) => ({
      product: f.product,
      manufacturer: f.manufacturer,
      formulation: f.formulation,
      cashPrice: f.cashPrice,
    })),
    defaultStore: DEFAULT_STORE,
    status: currentStatus(),
  };
}

function resetFluAppointments() {
  const cleared = ATTEMPTS.length;
  ATTEMPTS.length = 0;
  logger.info('Demo state reset', { cleared, service: SERVICE });
  incrementMetric('immunization.schedule.reset', { route: `${ROUTE}/reset` });
  return { success: true, cleared, status: currentStatus() };
}

module.exports = {
  processFluAppointment,
  resetFluAppointments,
  getCatalog,
  STORES,
  COHORTS,
  FORMULARY,
};
