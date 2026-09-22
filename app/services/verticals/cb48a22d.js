const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/cb48a22d/checkin';
const SERVICE = 'tenet-patient-experience';
const SLACK_MEMBER_ID = process.env.TENET_SLACK_MEMBER_ID || 'U08S7AVJ478';

/**
 * Tenet hospitals published on the public ER wait board. `timeZoneId` is the
 * Windows time zone the Millennium interface engine stamps for the facility.
 */
const FACILITIES = [
  { code: 'DMC', name: 'Detroit Receiving Hospital', city: 'Detroit', state: 'MI', market: 'Detroit Medical Center', timeZoneId: 'Eastern Standard Time', licensedBeds: 273 },
  { code: 'SFH', name: 'Saint Francis Hospital', city: 'Memphis', state: 'TN', market: 'Memphis', timeZoneId: 'Central Standard Time', licensedBeds: 519 },
  { code: 'BSW', name: 'Baptist Hospitals of Southeast Texas', city: 'Beaumont', state: 'TX', market: 'Southeast Texas', timeZoneId: 'Central Standard Time', licensedBeds: 421 },
  { code: 'DSH', name: 'Desert Regional Medical Center', city: 'Palm Springs', state: 'CA', market: 'Southern California', timeZoneId: 'Pacific Standard Time', licensedBeds: 385 },
  { code: 'HVL', name: 'Hi-Desert Medical Center', city: 'Joshua Tree', state: 'CA', market: 'Southern California', timeZoneId: 'Pacific Standard Time', licensedBeds: 179 },
  { code: 'PBH', name: 'Palm Beach Gardens Medical Center', city: 'Palm Beach Gardens', state: 'FL', market: 'South Florida', timeZoneId: 'Eastern Standard Time', licensedBeds: 199 },
];

/**
 * UTC offsets the platform applies when rendering facility wall-clock time.
 */
const FACILITY_ZONES = {
  'Eastern Standard Time': { utcOffsetMinutes: -240, abbreviation: 'EDT' },
  'Central Standard Time': { utcOffsetMinutes: -300, abbreviation: 'CDT' },
  'Pacific Standard Time': { utcOffsetMinutes: -420, abbreviation: 'PDT' },
};

/**
 * Online ER check-in ("Save My Spot") program registered per hospital: the
 * hold the ED front desk keeps for a self-scheduled arrival and the queue the
 * request is routed to.
 *
 * BUG: Hi-Desert Medical Center (HVL) was added to the public wait board with
 * the 2026 Southern California market rollup but was never registered here, so
 * a check-in at that hospital resolves `undefined`.
 */
const CHECKIN_PROGRAMS = {
  DMC: { holdMinutes: 30, queue: 'DMC-ED-SELFSCHED', fastTrack: true },
  SFH: { holdMinutes: 25, queue: 'SFH-ED-SELFSCHED', fastTrack: true },
  BSW: { holdMinutes: 25, queue: 'BSW-ED-SELFSCHED', fastTrack: false },
  DSH: { holdMinutes: 20, queue: 'DSH-ED-SELFSCHED', fastTrack: true },
  PBH: { holdMinutes: 30, queue: 'PBH-ED-SELFSCHED', fastTrack: false },
};

/**
 * Open (registered, not yet triaged) ED visits per facility, expressed as the
 * minutes since ED registration. The census feed replays these as ADT^A04
 * messages stamped in UTC.
 */
const ED_CENSUS_MINUTES = {
  DMC: [18, 34, 47, 62, 71, 88, 96, 124],
  SFH: [12, 26, 39, 55, 77, 91],
  BSW: [22, 41, 58, 63, 84],
  DSH: [31, 44, 52, 69, 85, 103, 117],
  HVL: [26, 38, 57, 74],
  PBH: [15, 29, 43, 66, 81, 98],
};

function pad(value, width) {
  return String(value).padStart(width, '0');
}

/**
 * Renders an ADT^A04 PID-derived registration timestamp the way the Millennium
 * interface engine publishes it: UTC wall clock with an explicit `+0000` offset.
 */
function formatHl7Timestamp(instant) {
  return (
    pad(instant.getUTCFullYear(), 4)
    + pad(instant.getUTCMonth() + 1, 2)
    + pad(instant.getUTCDate(), 2)
    + pad(instant.getUTCHours(), 2)
    + pad(instant.getUTCMinutes(), 2)
    + pad(instant.getUTCSeconds(), 2)
    + '+0000'
  );
}

/** Parses an HL7 v2 TS field published with a `+0000` offset. */
function parseHl7Timestamp(value) {
  const digits = String(value).slice(0, 14);
  return new Date(Date.UTC(
    Number(digits.slice(0, 4)),
    Number(digits.slice(4, 6)) - 1,
    Number(digits.slice(6, 8)),
    Number(digits.slice(8, 10)),
    Number(digits.slice(10, 12)),
    Number(digits.slice(12, 14)),
  ));
}

function resolveFacility(code) {
  return FACILITIES.find((f) => f.code === code) || null;
}

/** Wall-clock "now" at the hospital. */
function facilityLocalNow(facility, at = Date.now()) {
  const zone = FACILITY_ZONES[facility.timeZoneId];
  return new Date(at + zone.utcOffsetMinutes * 60000);
}

function formatBoardTime(facility, localNow) {
  const zone = FACILITY_ZONES[facility.timeZoneId];
  const hours = localNow.getUTCHours();
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${pad(localNow.getUTCMinutes(), 2)} ${hours < 12 ? 'AM' : 'PM'} ${zone.abbreviation}`;
}

function openEmergencyVisits(facilityCode, at = Date.now()) {
  return (ED_CENSUS_MINUTES[facilityCode] || []).map((minutesAgo, index) => ({
    visitId: `${facilityCode}-ED-${pad(index + 1, 3)}`,
    acuityLevel: (index % 4) + 1,
    registeredAt: formatHl7Timestamp(new Date(at - minutesAgo * 60000)),
  }));
}

function describeStatus(averageWaitMinutes) {
  if (averageWaitMinutes <= 15) return 'No wait';
  if (averageWaitMinutes <= 40) return 'Short wait';
  if (averageWaitMinutes <= 90) return 'Moderate wait';
  return 'Extended wait';
}

/**
 * Door-to-provider wait for one hospital: how long the patients currently in
 * the waiting room have been waiting since ED registration.
 */
function boardEntry(facility, at = Date.now()) {
  const waits = openEmergencyVisits(facility.code, at).map(
    (visit) => Math.round((at - parseHl7Timestamp(visit.registeredAt)) / 60000),
  );
  const average = waits.length === 0 ? 0 : Math.round(waits.reduce((sum, w) => sum + w, 0) / waits.length);

  return {
    facilityCode: facility.code,
    facilityName: facility.name,
    city: facility.city,
    state: facility.state,
    market: facility.market,
    patientsWaiting: waits.length,
    averageWaitMinutes: average,
    longestWaitMinutes: waits.length === 0 ? 0 : Math.max(...waits),
    status: describeStatus(average),
    updatedAtDisplay: formatBoardTime(facility, facilityLocalNow(facility, at)),
  };
}

function waitBoard(at = Date.now()) {
  return FACILITIES.map((facility) => boardEntry(facility, at));
}

function holdExpiry(facility, program, at = Date.now()) {
  const localNow = facilityLocalNow(facility, at + program.holdMinutes * 60000);
  return formatBoardTime(facility, localNow);
}

/**
 * Reserves an online ER check-in ("Save My Spot") slot at a hospital.
 */
async function reserveEdCheckin(data) {
  const startTime = Date.now();
  const confirmationId = `TEN-${uuidv4().slice(0, 8).toUpperCase()}`;

  logger.info('Processing Tenet ER online check-in', {
    confirmationId,
    facilityCode: data.facilityCode,
    reason: data.reason,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const facility = resolveFacility(data.facilityCode);
    const program = CHECKIN_PROGRAMS[facility.code];
    const entry = boardEntry(facility);

    const reservation = {
      confirmationId,
      queue: program.queue,
      holdMinutes: program.holdMinutes,
      holdUntilDisplay: holdExpiry(facility, program),
      fastTrackEligible: program.fastTrack && data.reason !== 'chest-pain',
    };

    const duration = Date.now() - startTime;

    incrementMetric('er_checkin.reserve.success', {
      route: ROUTE,
      facility: facility.code,
      market: facility.market,
    });
    recordTiming('er_checkin.reserve.latency', duration, { route: ROUTE });

    return {
      success: true,
      confirmationId,
      patientName: data.patientName,
      facility: {
        code: facility.code,
        name: facility.name,
        city: facility.city,
        state: facility.state,
        market: facility.market,
      },
      reservation,
      board: {
        patientsWaiting: entry.patientsWaiting,
        averageWaitMinutes: entry.averageWaitMinutes,
        status: entry.status,
        updatedAtDisplay: entry.updatedAtDisplay,
      },
      status: 'checked_in',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('er_checkin.reserve.failure', {
      route: ROUTE,
      errorClass: error.name,
      facility: data.facilityCode,
    });
    recordTiming('er_checkin.reserve.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Tenet ER online check-in failed', {
      confirmationId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      facilityCode: data.facilityCode,
      reason: data.reason,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, source: 'tenet-er-wait-board', facility: data.facilityCode },
      extra: { confirmationId, facilityCode: data.facilityCode, reason: data.reason },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/cb48a22d.js \u2014 reserveEdCheckin',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: 'cb48a22d',
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      service: SERVICE,
      verticalLabel: 'Tenet Health \u2014 ER Wait Board & Online Check-In',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'facility', value: String(data.facilityCode) },
      ],
      extra: { confirmationId, facilityCode: data.facilityCode, reason: data.reason },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@7.4.0`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Tenet ER check-in error', { error: err.message });
    });

    throw error;
  }
}

module.exports = {
  reserveEdCheckin,
  waitBoard,
  boardEntry,
  openEmergencyVisits,
  parseHl7Timestamp,
  formatHl7Timestamp,
  facilityLocalNow,
  resolveFacility,
  describeStatus,
  FACILITIES,
  FACILITY_ZONES,
  CHECKIN_PROGRAMS,
  ED_CENSUS_MINUTES,
};
