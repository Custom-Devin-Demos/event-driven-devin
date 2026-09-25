const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { GATEWAY_MANIFESTS, PGN_DECODE, getGatewayManifest } = require('./26af2083-gateway-manifests');

const SERVICE = '26af2083-telematics-ingest';
const ACCOUNT = {
  name: 'Cumberland Aggregates & Paving',
  accountNumber: 'CAP-20417',
  dealer: 'Talon Power Systems — Connected Services',
  region: 'Southeast US',
  timezone: 'America/New_York',
};
const STAGES = ['pull_messages', 'decode_j1939', 'compute_health', 'evaluate_events', 'publish'];
const INTERVAL_MIN = 5;
const REPLAY_HISTORY_JOBS = 16;
const STALE_AFTER_MS = Number(process.env.X26AF2083_STALE_AFTER_MS) || 30 * 60 * 1000;
const ALERT_COOLDOWN_MS = Number(process.env.X26AF2083_ALERT_COOLDOWN_MS) || 24 * 60 * 60 * 1000;
const CUTOVER_AGO_MS = 26 * 60 * 60 * 1000;

const SITES = {
  KQ: { code: 'KQ', name: 'Kingsport Quarry', city: 'Kingsport, TN', gateway: 'TCU-G2', geofence: 'KQ-PIT-01' },
  JC: { code: 'JC', name: 'Johnson City Yard', city: 'Johnson City, TN', gateway: 'TCU-G1', geofence: 'JC-YARD' },
  BR: { code: 'BR', name: 'Bristol Asphalt Plant', city: 'Bristol, TN', gateway: 'TCU-G3', geofence: 'BR-HMA-02' },
};

const ENGINE_MODELS = {
  'TX-450': { displacement: '4.5 L I4', ratedKw: 104, tier: 'EPA Tier 4 Final' },
  'TX-670': { displacement: '6.7 L I6', ratedKw: 224, tier: 'EPA Tier 4 Final' },
  'TX-900': { displacement: '9.0 L I6', ratedKw: 298, tier: 'EPA Tier 4 Final' },
  'TX-1300': { displacement: '13.0 L I6', ratedKw: 390, tier: 'EPA Tier 4 Final' },
};

// SAE J1939-71 SPN descriptions used by DM1 decode.
const SPN_NAMES = {
  91: 'Accelerator Pedal Position 1',
  94: 'Engine Fuel Delivery Pressure',
  100: 'Engine Oil Pressure',
  102: 'Engine Intake Manifold #1 Pressure',
  105: 'Engine Intake Manifold 1 Temperature',
  108: 'Barometric Pressure',
  110: 'Engine Coolant Temperature',
  111: 'Engine Coolant Level',
  168: 'Battery Potential / Power Input 1',
  173: 'Engine Exhaust Gas Temperature',
  190: 'Engine Speed',
  411: 'Engine EGR Differential Pressure',
  1761: 'Aftertreatment 1 DEF Tank Volume',
  3031: 'Aftertreatment 1 DEF Tank Temperature',
  3226: 'Aftertreatment 1 Outlet NOx',
  3251: 'Aftertreatment 1 DPF Differential Pressure',
  3719: 'Aftertreatment 1 DPF Soot Load Percent',
  4364: 'Aftertreatment 1 SCR Conversion Efficiency',
  5246: 'Aftertreatment SCR Operator Inducement Severity',
};

// SAE J1939-73 Failure Mode Identifiers.
const FMI_NAMES = {
  0: 'Data valid but above normal operational range — most severe',
  1: 'Data valid but below normal operational range — most severe',
  2: 'Data erratic, intermittent or incorrect',
  3: 'Voltage above normal, or shorted to high source',
  4: 'Voltage below normal, or shorted to low source',
  5: 'Current below normal or open circuit',
  6: 'Current above normal or grounded circuit',
  7: 'Mechanical system not responding or out of adjustment',
  9: 'Abnormal update rate',
  11: 'Root cause not known',
  12: 'Bad intelligent device or component',
  13: 'Out of calibration',
  14: 'Special instructions',
  15: 'Data valid but above normal operating range — least severe',
  16: 'Data valid but above normal operating range — moderately severe',
  17: 'Data valid but below normal operating range — least severe',
  18: 'Data valid but below normal operating range — moderately severe',
  31: 'Condition exists',
};

// DM1 DTC byte packing per J1939-73 SPN conversion method. The TCU firmware
// picks the method; the ingest must unpack with the matching layout because
// versions 1–3 are ambiguous on the wire (CM bit = 1) and version 4 (CM bit = 0)
// moved the SPN MSBs into byte 3.
const DTC_ENCODERS = {
  1: (spn, fmi, oc) => [(spn >> 8) & 0xFF, spn & 0xFF, ((spn >> 16) & 0x07) << 5 | (fmi & 0x1F), 0x80 | (oc & 0x7F)],
  2: (spn, fmi, oc) => [(spn >> 8) & 0xFF, spn & 0xFF, ((spn >> 16) & 0x07) | ((fmi & 0x1F) << 3), 0x80 | (oc & 0x7F)],
  3: (spn, fmi, oc) => [spn & 0xFF, (spn >> 8) & 0xFF, ((spn >> 16) & 0x07) << 5 | (fmi & 0x1F), 0x80 | (oc & 0x7F)],
  4: (spn, fmi, oc) => [spn & 0xFF, (spn >> 8) & 0xFF, ((spn >> 16) & 0x07) << 5 | (fmi & 0x1F), oc & 0x7F],
};

const DM1_DECODERS = {
  1: {
    unpack: ([b1, b2, b3, b4]) => ({ spn: (b1 << 8) | b2 | ((b3 >> 5) << 16), fmi: b3 & 0x1F, oc: b4 & 0x7F, cm: b4 >> 7 }),
  },
  2: {
    unpack: ([b1, b2, b3, b4]) => ({ spn: (b1 << 8) | b2 | ((b3 & 0x07) << 16), fmi: (b3 >> 3) & 0x1F, oc: b4 & 0x7F, cm: b4 >> 7 }),
  },
  3: {
    unpack: ([b1, b2, b3, b4]) => ({ spn: b1 | (b2 << 8) | ((b3 >> 5) << 16), fmi: b3 & 0x1F, oc: b4 & 0x7F, cm: b4 >> 7 }),
  },
};

const LAMP_PRIORITY = { RED: 0, AMBER: 1, PROTECT: 2, MIL: 3 };

// [assetId, site, type, machineModel, engineModel, engineSerial, hours, status,
//  rpm, load %, coolant °C, oil kPa, EGT °C, fuel %, fuel L/h, DEF %, batt V,
//  faults, lastServiceHours, serviceIntervalHours, workedTodayMin, idleTodayMin]
const ASSET_SEEDS = [
  ['WL-2101', 'KQ', 'Wheel loader', 'Talon WL-560', 'TX-670', '67T0418922', 6218.4, 'WORKING', 1710, 68, 88, 412, 486, 71, 22.4, 61, 27.9, [], 6000, 500, 312, 74],
  ['WL-2102', 'KQ', 'Wheel loader', 'Talon WL-560', 'TX-670', '67T0418961', 5742.1, 'WORKING', 1680, 64, 90, 398, 512, 58, 21.1, 47, 27.7, [
    { spn: 3719, fmi: 15, oc: 3, lamp: 'AMBER', sinceMin: 218 },
  ], 5500, 500, 298, 91],
  ['EX-3301', 'KQ', 'Excavator', 'Talon EX-350', 'TX-900', '90T0210377', 3104.7, 'WORKING', 1550, 72, 86, 440, 468, 82, 28.6, 73, 28.1, [], 3000, 500, 331, 52],
  ['EX-3302', 'KQ', 'Excavator', 'Talon EX-350', 'TX-900', '90T0210402', 2988.3, 'IDLING', 820, 6, 79, 310, 262, 44, 4.1, 69, 27.8, [], 2500, 500, 187, 164],
  ['HT-4401', 'KQ', 'Articulated haul truck', 'Talon HT-40', 'TX-1300', '13T0107118', 9871.6, 'WORKING', 1820, 81, 91, 455, 531, 63, 41.7, 38, 27.6, [], 9500, 500, 342, 61],
  ['HT-4402', 'KQ', 'Articulated haul truck', 'Talon HT-40', 'TX-1300', '13T0107124', 9702.0, 'WORKING', 1400, 55, 106, 402, 558, 49, 33.0, 52, 27.5, [
    { spn: 110, fmi: 0, oc: 1, lamp: 'RED', sinceMin: 41 },
    { spn: 111, fmi: 17, oc: 1, lamp: 'AMBER', sinceMin: 39 },
  ], 9500, 500, 276, 88],
  ['HT-4403', 'KQ', 'Articulated haul truck', 'Talon HT-40', 'TX-1300', '13T0107131', 9410.9, 'KEY_OFF', 0, 0, 31, 0, 44, 88, 0, 77, 25.9, [], 9000, 500, 0, 0],
  ['CR-6601', 'KQ', 'Jaw crusher power unit', 'Talon PU-390', 'TX-1300', '13T0098544', 12406.2, 'WORKING', 1800, 77, 89, 431, 502, 54, 38.9, 44, 28.0, [], 12000, 500, 366, 38],
  ['GS-5501', 'KQ', 'Generator set', 'Talon GS-250', 'TX-670', '67T0387210', 14882.5, 'WORKING', 1800, 46, 84, 388, 441, 67, 19.3, null, 27.4, [], 14500, 500, 398, 0],
  ['WL-2103', 'JC', 'Wheel loader', 'Talon WL-560', 'TX-670', '67T0402188', 7311.8, 'IDLING', 780, 5, 76, 296, 231, 39, 3.6, 58, 27.6, [], 7000, 500, 142, 121],
  ['HT-4404', 'JC', 'Articulated haul truck', 'Talon HT-40', 'TX-1300', '13T0104790', 10120.3, 'WORKING', 1760, 74, 92, 447, 522, 57, 36.2, 9, 27.8, [
    { spn: 1761, fmi: 17, oc: 2, lamp: 'AMBER', sinceMin: 96 },
  ], 10000, 500, 288, 70],
  ['WP-7701', 'JC', 'Dewatering pump', 'Talon WP-150', 'TX-450', '45T0056113', 4407.0, 'KEY_OFF', 0, 0, 29, 0, 38, 92, 0, null, 25.6, [], 4000, 500, 0, 0],
  ['GS-5502', 'JC', 'Generator set', 'Talon GS-250', 'TX-670', '67T0387244', 13217.9, 'WORKING', 1800, 41, 83, 391, 428, 72, 18.1, null, 27.5, [], 13000, 500, 398, 0],
  ['WL-2104', 'BR', 'Wheel loader', 'Talon WL-560', 'TX-670', '67T0418977', 4988.6, 'WORKING', 1720, 66, 87, 408, 479, 66, 22.0, 63, 27.9, [], 4500, 500, 305, 79],
  ['EX-3303', 'BR', 'Excavator', 'Talon EX-350', 'TX-900', '90T0210419', 2211.4, 'WORKING', 1580, 70, 85, 436, 471, 74, 27.9, 71, 28.0, [], 2000, 500, 318, 66],
  ['HT-4405', 'BR', 'Articulated haul truck', 'Talon HT-40', 'TX-1300', '13T0107140', 8640.2, 'WORKING', 1790, 79, 90, 451, 527, 61, 40.2, 41, 27.7, [], 8500, 500, 336, 58],
  ['HT-4406', 'BR', 'Articulated haul truck', 'Talon HT-40', 'TX-1300', '13T0107153', 8577.7, 'IDLING', 810, 7, 80, 305, 258, 52, 4.0, 46, 27.8, [
    { spn: 3226, fmi: 16, oc: 4, lamp: 'AMBER', sinceMin: 512 },
  ], 8500, 500, 201, 172],
  ['CR-6602', 'BR', 'Cone crusher power unit', 'Talon PU-390', 'TX-1300', '13T0098561', 11050.8, 'WORKING', 1800, 75, 88, 428, 498, 49, 38.1, 39, 28.0, [], 11000, 500, 361, 44],
  ['GS-5503', 'BR', 'Generator set', 'Talon GS-250', 'TX-670', '67T0387301', 9964.3, 'WORKING', 1800, 44, 84, 390, 435, 69, 18.8, null, 27.5, [], 9500, 500, 398, 0],
];

const ASSETS = {};
const EVENTS = [];
const RUNS = [];
const MAX_RUNS = 500;
const MAX_RUNS_PAGE = 200;
const failureTimestamps = [];
const consecutiveFailures = {};
const lastAlerts = {};
const lastSuccessfulPublishes = {};
let schedulerHandle = null;
let eventSequence = 88120;

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function nextEventId() {
  eventSequence += 1;
  return `EV-${eventSequence}`;
}

function accountDate(now) {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: ACCOUNT.timezone,
  }).format(new Date(now));
}

// Aligned INTERVAL_MIN bucket a publish falls in.
function intervalBucket(now) {
  const bucketMs = INTERVAL_MIN * 60 * 1000;
  return Math.floor(now / bucketMs) * bucketMs;
}

// Every run pulls the trailing INTERVAL_MIN of messages, so two publishes closer
// together than that re-read the same minutes. The share of the previous window
// the new one covers again is withdrawn before the new window is credited: a
// re-run seconds later replaces its predecessor outright, a run two minutes
// later leaves only the two minutes it did not re-sample. Only the part of the
// previous window credited to this account-local day (after `floorMs`) counts.
function overlapWithPrevious(previousEndMs, now, floorMs) {
  if (previousEndMs === null || previousEndMs === undefined) return 0;
  const intervalMs = INTERVAL_MIN * 60 * 1000;
  const previousStart = Math.max(previousEndMs - intervalMs, floorMs);
  const credited = previousEndMs - previousStart;
  if (credited <= 0) return 0;
  const resampledFrom = Math.max(now - intervalMs, previousStart);
  return Math.max(0, Math.min(1, (previousEndMs - resampledFrom) / credited));
}

// Maintenance reminders are one event per asset whose title tracks the meter;
// everything else is identified by its title (fault code, exceedance).
function sameEvent(a, b) {
  if (a.assetId !== b.assetId) return false;
  if (a.type === 'SERVICE' || b.type === 'SERVICE') return a.type === b.type;
  return a.title === b.title;
}

function recordRun(run, { prepend = false } = {}) {
  if (prepend) RUNS.unshift(run); else RUNS.push(run);
  if (RUNS.length > MAX_RUNS) RUNS.length = MAX_RUNS;
  if (run.status === 'failed') failureTimestamps.push(new Date(run.startedAt).getTime());
  return run;
}

function describeFault(fault) {
  return {
    ...fault,
    spnName: SPN_NAMES[fault.spn] || `SPN ${fault.spn}`,
    fmiName: FMI_NAMES[fault.fmi] || `FMI ${fault.fmi}`,
    code: `SPN ${fault.spn} FMI ${fault.fmi}`,
  };
}

function derateFor(faults) {
  const red = faults.find((fault) => fault.lamp === 'RED');
  if (!red) return null;
  if (red.spn === 110) return { percent: 25, reason: 'Engine coolant temperature above shutdown threshold — torque limited to 75 %' };
  if (red.spn === 100) return { percent: 50, reason: 'Engine oil pressure below protection threshold — torque limited to 50 %' };
  return { percent: 25, reason: `Red stop lamp active (${red.code}) — torque limited` };
}

function lampSummary(faults) {
  const lamps = { RED: false, AMBER: false, PROTECT: false, MIL: false };
  faults.forEach((fault) => { lamps[fault.lamp] = true; });
  return lamps;
}

function statusFrom(rpm, loadPct) {
  if (!rpm) return 'KEY_OFF';
  if (loadPct < 12) return 'IDLING';
  return 'WORKING';
}

function buildAsset(seed, now, random) {
  const [assetId, siteCode, type, machineModel, engineModel, engineSerial, hours, status, rpm, loadPct, coolantC, oilKpa, egtC, fuelPct, fuelRateLph, defPct, battV, faultSeeds, lastServiceHours, serviceIntervalHours, workedTodayMin, idleTodayMin] = seed;
  const site = SITES[siteCode];
  const faults = faultSeeds.map((fault) => describeFault({
    ...fault,
    firstSeenAt: new Date(now - fault.sinceMin * 60000).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
    status: 'ACTIVE',
  }));
  const stateSinceMin = status === 'KEY_OFF' ? 95 + Math.floor(random() * 240) : 4 + Math.floor(random() * 38);
  return {
    assetId,
    site: siteCode,
    siteName: site.name,
    gateway: site.gateway,
    type,
    machineModel,
    engineModel,
    engine: { ...ENGINE_MODELS[engineModel], model: engineModel, serial: engineSerial },
    unitNumber: `CAP-${assetId.replace('-', '')}`,
    tcuSerial: `${site.gateway.replace('TCU-', 'T')}${String(engineSerial).slice(-6)}`,
    imei: `35${String(engineSerial).replace(/\D/g, '').padEnd(13, '4')}`.slice(0, 15),
    rssiDbm: -(58 + Math.floor(random() * 30)),
    status,
    stateSince: new Date(now - stateSinceMin * 60000).toISOString(),
    hours: round(hours, 1),
    serviceMeter: { lastServiceHours, intervalHours: serviceIntervalHours, dueAtHours: lastServiceHours + serviceIntervalHours, hoursToService: round(lastServiceHours + serviceIntervalHours - hours, 1) },
    utilization: {
      date: accountDate(now),
      workedTodayMin,
      idleTodayMin,
      idlePct: workedTodayMin + idleTodayMin ? round((idleTodayMin / (workedTodayMin + idleTodayMin)) * 100, 1) : 0,
      lastBucket: null,
      lastIntervalEndMs: null,
      lastInterval: null,
    },
    telemetry: {
      rpm, loadPct, coolantC, oilKpa, egtC, fuelPct, fuelRateLph, defPct, battV,
    },
    faults,
    lamps: lampSummary(faults),
    derate: derateFor(faults),
    location: { geofence: site.geofence, city: site.city },
    lastReportAt: new Date(now).toISOString(),
    lastPositionAt: new Date(now - Math.floor(random() * 90) * 1000).toISOString(),
    quality: 'GOOD',
  };
}

function seedStore(now = Date.now()) {
  const random = mulberry32(0x26af2083);
  Object.keys(ASSETS).forEach((key) => delete ASSETS[key]);
  EVENTS.length = 0;
  RUNS.length = 0;
  failureTimestamps.length = 0;
  Object.keys(consecutiveFailures).forEach((key) => delete consecutiveFailures[key]);
  Object.keys(lastAlerts).forEach((key) => delete lastAlerts[key]);
  Object.keys(lastSuccessfulPublishes).forEach((key) => delete lastSuccessfulPublishes[key]);
  eventSequence = 88120;

  const cutoverAt = now - CUTOVER_AGO_MS;
  ASSET_SEEDS.forEach((seed) => {
    const site = SITES[seed[1]];
    const isCutover = site.gateway === 'TCU-G3';
    const asset = buildAsset(seed, isCutover ? cutoverAt : now, random);
    if (isCutover) {
      asset.quality = 'STALE';
      asset.lastPositionAt = new Date(cutoverAt).toISOString();
    }
    ASSETS[asset.assetId] = asset;
  });

  Object.values(GATEWAY_MANIFESTS).forEach((manifest) => {
    const isCutover = manifest.family === 'TCU-G3';
    const intervalMs = INTERVAL_MIN * 60 * 1000;
    if (isCutover) {
      lastSuccessfulPublishes[manifest.family] = cutoverAt;
      recordRun({
        runId: `job-${uuidv4().replace(/-/g, '').slice(0, 8)}`, gateway: manifest.family, trigger: 'scheduled', startedAt: new Date(cutoverAt - intervalMs).toISOString(), finishedAt: new Date(cutoverAt - intervalMs + 1180).toISOString(), durationMs: 1180, stageReached: 'publish', status: 'succeeded', messagesIn: 6 * 10, assetsOut: 6, error: null,
      });
      const failureOffsets = [0, 5, 10, 15, 6 * 60, 12 * 60, 18 * 60, CUTOVER_AGO_MS / 60000 - 5].map((min) => cutoverAt + min * 60000).filter((ts) => ts < now);
      failureOffsets.forEach((startedAt) => {
        const durationMs = 300 + Math.floor(random() * 220);
        recordRun({
          runId: `job-${uuidv4().replace(/-/g, '').slice(0, 8)}`, gateway: manifest.family, trigger: 'scheduled', startedAt: new Date(startedAt).toISOString(), finishedAt: new Date(startedAt + durationMs).toISOString(), durationMs, stageReached: 'decode_j1939', status: 'failed', messagesIn: 6 * 10, assetsOut: 0, error: { name: 'TypeError', message: "Cannot read properties of undefined (reading 'unpack')", stage: 'decode_j1939' },
        });
      });
      consecutiveFailures[manifest.family] = failureOffsets.length;
      const gatewayEvent = {
        id: nextEventId(),
        assetId: null,
        site: 'BR',
        gateway: manifest.family,
        type: 'COMMS',
        severity: 'HIGH',
        title: `${manifest.family} ingest failing at decode_j1939`,
        detail: `${failureOffsets.length} consecutive interval jobs failed since firmware ${manifest.firmware.split(' ')[0]} rollout. Messages are arriving on ${manifest.topic}; no asset has published since cutover.`,
        openedAt: new Date(cutoverAt).toISOString(),
        state: 'OPEN',
        ackBy: null,
        ackAt: null,
        closedAt: null,
      };
      EVENTS.push(gatewayEvent);
    } else {
      lastSuccessfulPublishes[manifest.family] = now - 2 * 60000;
      for (let i = 8; i >= 1; i -= 1) {
        const startedAt = now - 2 * 60000 - i * intervalMs;
        const durationMs = 640 + Math.floor(random() * 500);
        const assets = Object.values(ASSETS).filter((asset) => asset.gateway === manifest.family).length;
        recordRun({
          runId: `job-${uuidv4().replace(/-/g, '').slice(0, 8)}`, gateway: manifest.family, trigger: 'scheduled', startedAt: new Date(startedAt).toISOString(), finishedAt: new Date(startedAt + durationMs).toISOString(), durationMs, stageReached: 'publish', status: 'succeeded', messagesIn: assets * Math.round((INTERVAL_MIN * 60) / manifest.reportIntervalSec), assetsOut: assets, error: null,
        });
      }
      consecutiveFailures[manifest.family] = 0;
    }
  });

  Object.values(ASSETS).forEach((asset) => {
    if (asset.quality === 'STALE') {
      EVENTS.push({
        id: nextEventId(), assetId: asset.assetId, site: asset.site, gateway: asset.gateway, type: 'COMMS', severity: 'MEDIUM', title: 'Asset not reporting', detail: `No decoded message from TCU ${asset.tcuSerial} for ${Math.round((Date.now() - cutoverAt) / 3600000)} h. TCU heartbeat is present on the broker.`, openedAt: new Date(cutoverAt + 30 * 60000).toISOString(), state: 'OPEN', ackBy: null, ackAt: null, closedAt: null,
      });
      return;
    }
    asset.faults.forEach((fault) => {
      EVENTS.push({
        id: nextEventId(), assetId: asset.assetId, site: asset.site, gateway: asset.gateway, type: 'FAULT', severity: fault.lamp === 'RED' ? 'HIGH' : 'MEDIUM', title: `${fault.code} — ${fault.spnName}`, detail: `${fault.fmiName}. Occurrence count ${fault.oc}. ${fault.lamp === 'RED' ? 'Red stop lamp' : 'Amber warning lamp'} commanded on.`, openedAt: fault.firstSeenAt, state: 'OPEN', ackBy: null, ackAt: null, closedAt: null,
      });
    });
    if (asset.derate) {
      EVENTS.push({
        id: nextEventId(), assetId: asset.assetId, site: asset.site, gateway: asset.gateway, type: 'EXCEEDANCE', severity: 'HIGH', title: `Engine derate active — ${asset.derate.percent} %`, detail: asset.derate.reason, openedAt: asset.faults[0].firstSeenAt, state: 'OPEN', ackBy: null, ackAt: null, closedAt: null,
      });
    }
    if (asset.serviceMeter.hoursToService <= 50) {
      EVENTS.push({
        id: nextEventId(), assetId: asset.assetId, site: asset.site, gateway: asset.gateway, type: 'SERVICE', severity: asset.serviceMeter.hoursToService < 0 ? 'MEDIUM' : 'LOW', title: asset.serviceMeter.hoursToService < 0 ? `PM ${asset.serviceMeter.intervalHours} h overdue` : `PM ${asset.serviceMeter.intervalHours} h due in ${asset.serviceMeter.hoursToService} h`, detail: `Service meter ${asset.hours} h; interval due at ${asset.serviceMeter.dueAtHours} h.`, openedAt: new Date(now - 6 * 3600000).toISOString(), state: 'OPEN', ackBy: null, ackAt: null, closedAt: null,
      });
    }
  });
  EVENTS.find((event) => event.assetId === 'HT-4404' && event.type === 'FAULT').state = 'ACKED';
  EVENTS.find((event) => event.assetId === 'HT-4404' && event.type === 'FAULT').ackBy = 'fleet.dispatch';
  EVENTS.find((event) => event.assetId === 'HT-4404' && event.type === 'FAULT').ackAt = new Date(now - 70 * 60000).toISOString();
}

// --- pipeline ---------------------------------------------------------------

function jitter(random, value, spread) {
  return value === null || value === undefined ? value : round(value + (random() - 0.5) * spread, 1);
}

function pullMessages(manifest, now) {
  const random = mulberry32((now / 1000) | 0);
  const assets = Object.values(ASSETS).filter((asset) => asset.gateway === manifest.family);
  const perAsset = Math.max(1, Math.round((INTERVAL_MIN * 60) / manifest.reportIntervalSec));
  const messages = [];
  const encode = DTC_ENCODERS[manifest.dm1.spnConversionMethod];
  assets.forEach((asset) => {
    const base = asset.telemetry;
    for (let i = perAsset - 1; i >= 0; i -= 1) {
      const ts = now - i * manifest.reportIntervalSec * 1000;
      const running = base.rpm > 0;
      messages.push({
        topic: manifest.topic.replace('{assetId}', asset.assetId),
        assetId: asset.assetId,
        ts: new Date(ts).toISOString(),
        seq: 1 + Math.floor(ts / 1000) % 65536,
        pgns: {
          61444: { 190: running ? jitter(random, base.rpm, 40) : 0, 92: running ? Math.max(0, Math.round(jitter(random, base.loadPct, 8))) : 0 },
          65262: { 110: jitter(random, base.coolantC, 1.5) },
          65263: { 100: running ? jitter(random, base.oilKpa, 12) : 0 },
          65031: manifest.pgns.includes(65031) ? { 173: running ? jitter(random, base.egtC, 14) : base.egtC } : undefined,
          65253: { 247: round(asset.hours + (running ? (perAsset - 1 - i) * (manifest.reportIntervalSec / 3600) : 0), 2) },
          65266: { 183: running ? jitter(random, base.fuelRateLph, 2.2) : 0 },
          65276: { 96: jitter(random, base.fuelPct, 0.4) },
          65271: { 168: jitter(random, base.battV, 0.3) },
          65110: manifest.pgns.includes(65110) && base.defPct !== null ? { 1761: jitter(random, base.defPct, 0.3) } : undefined,
        },
        dm1: {
          lamps: asset.lamps,
          dtcs: asset.faults.map((fault) => encode(fault.spn, fault.fmi, fault.oc)),
        },
      });
    }
  });
  return { messages, messagesIn: messages.length };
}

function decodeJ1939(manifest, messages) {
  return messages.map((message) => {
    const signals = {};
    Object.values(message.pgns).forEach((spns) => {
      if (!spns) return;
      Object.entries(spns).forEach(([spn, value]) => { signals[spn] = value; });
    });
    const dtcs = message.dm1.dtcs.map((bytes) => {
      const dtc = DM1_DECODERS[manifest.dm1.spnConversionMethod].unpack(bytes);
      return describeFault({ ...dtc, lamp: lampFor(message.dm1.lamps, dtc) });
    });
    return { assetId: message.assetId, ts: message.ts, signals, lamps: message.dm1.lamps, dtcs };
  });
}

function lampFor(lamps, dtc) {
  if (lamps.RED && (dtc.spn === 110 || dtc.spn === 100 || dtc.fmi === 0 || dtc.fmi === 1)) return 'RED';
  if (lamps.PROTECT && dtc.spn === 111) return 'PROTECT';
  return 'AMBER';
}

function computeHealth(manifest, decoded, now) {
  const byAsset = {};
  decoded.forEach((sample) => {
    if (!byAsset[sample.assetId]) byAsset[sample.assetId] = [];
    byAsset[sample.assetId].push(sample);
  });
  const today = accountDate(now);
  const bucket = intervalBucket(now);
  const dayStartMs = accountDayStart(now);
  return Object.entries(byAsset).map(([assetId, samples]) => {
    const latest = samples[samples.length - 1];
    const previous = ASSETS[assetId];
    const rpm = Number(latest.signals[190] || 0);
    const loadPct = Number(latest.signals[92] || 0);
    const status = statusFrom(rpm, loadPct);
    const minutes = INTERVAL_MIN;
    const worked = samples.filter((sample) => statusFrom(sample.signals[190], sample.signals[92]) === 'WORKING').length / samples.length;
    const idle = samples.filter((sample) => statusFrom(sample.signals[190], sample.signals[92]) === 'IDLING').length / samples.length;
    const prior = previous.utilization.date === today ? previous.utilization : { workedTodayMin: 0, idleTodayMin: 0 };
    const overlap = overlapWithPrevious(prior.lastIntervalEndMs, now, dayStartMs);
    const replaced = prior.lastInterval
      ? { worked: Math.round(prior.lastInterval.worked * overlap), idle: Math.round(prior.lastInterval.idle * overlap) }
      : { worked: 0, idle: 0 };
    // Minutes sampled before account-local midnight belong to yesterday's totals.
    const inDay = Math.min(1, (now - dayStartMs) / (minutes * 60 * 1000));
    const intervalWorked = round(worked * minutes * inDay, 0);
    const intervalIdle = round(idle * minutes * inDay, 0);
    const workedTodayMin = prior.workedTodayMin - replaced.worked + intervalWorked;
    const idleTodayMin = prior.idleTodayMin - replaced.idle + intervalIdle;
    const faults = latest.dtcs.map((dtc) => {
      const known = previous.faults.find((fault) => fault.spn === dtc.spn && fault.fmi === dtc.fmi);
      return { ...dtc, firstSeenAt: known ? known.firstSeenAt : latest.ts, lastSeenAt: latest.ts, status: 'ACTIVE' };
    });
    const hours = Number(latest.signals[247] || previous.hours);
    return {
      assetId,
      status,
      stateSince: status === previous.status ? previous.stateSince : new Date(now).toISOString(),
      hours: round(hours, 1),
      serviceMeter: { ...previous.serviceMeter, hoursToService: round(previous.serviceMeter.dueAtHours - hours, 1) },
      utilization: {
        date: today,
        workedTodayMin,
        idleTodayMin,
        idlePct: workedTodayMin + idleTodayMin ? round((idleTodayMin / (workedTodayMin + idleTodayMin)) * 100, 1) : 0,
        lastBucket: bucket,
        lastIntervalEndMs: now,
        lastInterval: { worked: intervalWorked, idle: intervalIdle },
      },
      telemetry: {
        rpm: Math.round(rpm),
        loadPct: Math.round(loadPct),
        coolantC: latest.signals[110] ?? previous.telemetry.coolantC,
        oilKpa: latest.signals[100] ?? previous.telemetry.oilKpa,
        egtC: latest.signals[173] ?? previous.telemetry.egtC,
        fuelPct: latest.signals[96] ?? previous.telemetry.fuelPct,
        fuelRateLph: latest.signals[183] ?? previous.telemetry.fuelRateLph,
        defPct: latest.signals[1761] ?? previous.telemetry.defPct,
        battV: latest.signals[168] ?? previous.telemetry.battV,
      },
      faults,
      lamps: latest.lamps,
      derate: derateFor(faults),
      lastReportAt: latest.ts,
      lastPositionAt: latest.ts,
      quality: 'GOOD',
      samples: samples.length,
    };
  });
}

function evaluateEvents(health, now) {
  const found = [];
  health.forEach((asset) => {
    asset.faults.forEach((fault) => {
      found.push({ assetId: asset.assetId, type: 'FAULT', severity: fault.lamp === 'RED' ? 'HIGH' : 'MEDIUM', title: `${fault.code} — ${fault.spnName}`, detail: `${fault.fmiName}. Occurrence count ${fault.oc}. ${fault.lamp === 'RED' ? 'Red stop lamp' : 'Amber warning lamp'} commanded on.`, openedAt: fault.firstSeenAt });
    });
    if (asset.derate) {
      found.push({ assetId: asset.assetId, type: 'EXCEEDANCE', severity: 'HIGH', title: `Engine derate active — ${asset.derate.percent} %`, detail: asset.derate.reason, openedAt: asset.faults[0].firstSeenAt });
    }
    if (asset.telemetry.coolantC >= 104 && !asset.faults.some((fault) => fault.spn === 110)) {
      found.push({ assetId: asset.assetId, type: 'EXCEEDANCE', severity: 'MEDIUM', title: 'Coolant temperature above 104 °C', detail: `SPN 110 reported ${asset.telemetry.coolantC} °C for the interval.`, openedAt: new Date(now).toISOString() });
    }
    if (asset.serviceMeter.hoursToService <= 50) {
      found.push({ assetId: asset.assetId, type: 'SERVICE', severity: asset.serviceMeter.hoursToService < 0 ? 'MEDIUM' : 'LOW', title: asset.serviceMeter.hoursToService < 0 ? `PM ${asset.serviceMeter.intervalHours} h overdue` : `PM ${asset.serviceMeter.intervalHours} h due in ${asset.serviceMeter.hoursToService} h`, detail: `Service meter ${asset.hours} h; interval due at ${asset.serviceMeter.dueAtHours} h.`, openedAt: new Date(now).toISOString() });
    }
  });
  return found;
}

function publish(manifest, health, events, run, now = Date.now()) {
  const publishedAt = new Date(now).toISOString();
  health.forEach((update) => {
    const previous = ASSETS[update.assetId];
    const rest = { ...update };
    delete rest.samples;
    ASSETS[update.assetId] = { ...previous, ...rest, site: previous.site, gateway: previous.gateway };
  });
  const assetIds = health.map((asset) => asset.assetId);
  EVENTS.filter((event) => assetIds.includes(event.assetId) && event.state !== 'CLOSED' && event.type !== 'COMMS')
    .forEach((event) => {
      const still = events.find((candidate) => sameEvent(candidate, event));
      if (!still) {
        event.state = 'CLOSED';
        event.closedAt = publishedAt;
      } else {
        event.title = still.title;
        event.detail = still.detail;
        event.severity = still.severity;
      }
    });
  events.forEach((event) => {
    const existing = EVENTS.find((candidate) => sameEvent(candidate, event) && candidate.state !== 'CLOSED');
    if (!existing) {
      EVENTS.push({ id: nextEventId(), site: ASSETS[event.assetId].site, gateway: manifest.family, ...event, state: 'OPEN', ackBy: null, ackAt: null, closedAt: null });
    }
  });
  EVENTS.filter((event) => event.type === 'COMMS' && event.gateway === manifest.family && event.state !== 'CLOSED')
    .forEach((event) => {
      event.state = 'CLOSED';
      event.closedAt = publishedAt;
    });

  lastSuccessfulPublishes[manifest.family] = new Date(publishedAt).getTime();
  consecutiveFailures[manifest.family] = 0;
  run.finishedAt = publishedAt;
  run.durationMs = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  run.stageReached = 'publish';
  run.status = 'succeeded';
  run.assetsOut = health.length;
  return recordRun(run, { prepend: true });
}

function staleHoursFor(family, now) {
  const last = lastSuccessfulPublishes[family];
  return last ? Math.round((now - last) / 3600000) : null;
}

async function sendAlert({ error, manifest, run, stage, requestId, messagesIn, meta }) {
  const now = Date.now();
  const staleHours = staleHoursFor(manifest.family, now);
  const affected = Object.values(ASSETS).filter((asset) => asset.gateway === manifest.family);
  const sites = [...new Set(affected.map((asset) => asset.siteName))];
  const alertData = {
    issueTitle: `${error.name}: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/26af2083-${manifest.family.toLowerCase()}-dm1`,
    culprit: 'app/services/verticals/26af2083.js — decodeJ1939',
    errorType: error.name,
    errorValue: error.message,
    devinUserId: meta.devinUserId,
    devinEmail: meta.devinEmail,
    devinOrgId: meta.devinOrgId,
    customer: '26af2083',
    service: SERVICE,
    verticalLabel: 'Talon Power Systems — Talon Connect J1939 Telematics Ingest',
    tags: [
      { key: 'route', value: '/api/26af2083/runs' },
      { key: 'service', value: SERVICE },
      { key: 'stage', value: stage },
      { key: 'gateway', value: manifest.family },
      { key: 'firmware', value: manifest.firmware.split(' ')[0] },
      { key: 'dm1_conversion_method', value: String(manifest.dm1.spnConversionMethod) },
      { key: 'account', value: ACCOUNT.accountNumber },
    ],
    extra: {
      requestId,
      runId: run.runId,
      gateway: manifest.family,
      hardware: manifest.hardware,
      firmware: manifest.firmware,
      payloadFormat: manifest.payloadFormat,
      manifestVersion: manifest.manifestVersion,
      dm1: manifest.dm1,
      topic: manifest.topic,
      stage,
      messagesIn,
      affectedAssets: affected.map((asset) => asset.assetId),
      affectedSites: sites,
      consecutiveFailures: consecutiveFailures[manifest.family],
      lastSuccessfulPublishAt: lastSuccessfulPublishes[manifest.family]
        ? new Date(lastSuccessfulPublishes[manifest.family]).toISOString() : null,
      promptContext: `${affected.length} Talon-powered assets at ${sites.join(', ')} (${ACCOUNT.name}, account ${ACCOUNT.accountNumber}) show Not Reporting in Talon Connect for ~${staleHours}h. Their ${manifest.family} gateways are healthy and publishing to ${manifest.topic}; every interval ingest since the firmware ${manifest.firmware.split(' ')[0]} rollout has failed at the ${stage} stage (${consecutiveFailures[manifest.family] || 0} consecutive), so no engine hours, fault codes or fuel data reach the customer. The dealer service desk is fielding calls that machines "show offline but the TCU LED is green".`,
    },
    level: 'error',
    platform: 'node',
    firstSeen: '',
    lastSeen: new Date().toISOString(),
    count: '',
    shortId: '',
    project: 'event-driven-devin',
    release: process.env.SENTRY_RELEASE || 'telematics-ingest@7.3.0',
    environment: process.env.DD_ENV || 'prod',
    triggeredRule: '',
    promptAppendix: 'When you fix this, add regression tests that load every gateway manifest and assert its DM1 SPN conversion method resolves to a decoder, and that a method-4 DTC round-trips through encode/unpack to the same SPN/FMI/OC. Then record a browser video of Talon Connect showing the Bristol Asphalt Plant assets leaving Not Reporting and the TCU-G3 COMMS event closing.',
  };
  return createSessionAndAlert(alertData).catch((alertError) => {
    logger.error('Telematics ingest alert attempt failed', {
      service: SERVICE,
      gateway: manifest.family,
      runId: run.runId,
      error: alertError.message,
    });
    return null;
  });
}

async function runPipeline(family, meta = {}) {
  const manifest = getGatewayManifest(family);
  if (!manifest) throw new Error(`Unknown gateway ${family}`);
  const requestId = uuidv4();
  const startedAt = Date.now();
  let stage = 'pull_messages';
  let messagesIn = 0;
  const run = {
    runId: `job-${uuidv4().replace(/-/g, '').slice(0, 8)}`,
    gateway: family,
    trigger: meta.trigger || 'manual',
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: null,
    durationMs: null,
    stageReached: stage,
    status: 'failed',
    messagesIn: 0,
    assetsOut: 0,
    error: null,
  };
  logger.info('Starting telematics interval ingest', { service: SERVICE, gateway: family, runId: run.runId, stage });
  try {
    const pulled = pullMessages(manifest, Date.now());
    messagesIn = pulled.messagesIn;
    run.messagesIn = messagesIn;
    if (process.env.NODE_ENV !== 'test') {
      await new Promise((resolve) => setTimeout(resolve, 120 + Math.random() * 180));
    }
    stage = 'decode_j1939';
    run.stageReached = stage;
    const decoded = decodeJ1939(manifest, pulled.messages);
    stage = 'compute_health';
    run.stageReached = stage;
    const health = computeHealth(manifest, decoded, Date.now());
    stage = 'evaluate_events';
    run.stageReached = stage;
    const events = evaluateEvents(health, Date.now());
    stage = 'publish';
    run.stageReached = stage;
    const published = publish(manifest, health, events, run);
    incrementMetric('telematics_ingest.interval.run', { gateway: family, status: 'succeeded' });
    recordTiming('telematics_ingest.interval.duration', published.durationMs, { gateway: family, status: 'succeeded' });
    return published;
  } catch (error) {
    run.finishedAt = new Date().toISOString();
    run.durationMs = Date.now() - startedAt;
    run.stageReached = stage;
    run.messagesIn = messagesIn;
    run.error = { name: error.name, message: error.message, stage };
    recordRun(run, { prepend: true });
    consecutiveFailures[family] = (consecutiveFailures[family] || 0) + 1;
    incrementMetric('telematics_ingest.interval.run', { gateway: family, status: 'failed' });
    recordTiming('telematics_ingest.interval.duration', run.durationMs, { gateway: family, status: 'failed' });
    Sentry.captureException(error, {
      tags: {
        service: SERVICE,
        gateway: family,
        account: ACCOUNT.accountNumber,
        stage,
        alert_path: 'instant',
      },
    });
    const shouldAlert = run.trigger === 'manual'
      || (consecutiveFailures[family] >= 3
        && (!lastAlerts[family] || Date.now() - lastAlerts[family] > ALERT_COOLDOWN_MS));
    if (shouldAlert) {
      const delivered = await sendAlert({ error, manifest, run, stage, requestId, messagesIn, meta });
      if (delivered) lastAlerts[family] = Date.now();
    }
    return run;
  }
}

async function runAllGateways(meta = {}) {
  const runs = [];
  for (const family of Object.keys(GATEWAY_MANIFESTS)) {
    runs.push(await runPipeline(family, meta));
  }
  return runs;
}

function listRuns({ limit = 50, gateway } = {}) {
  const parsedLimit = Number(limit);
  const count = Math.min(Math.max(parsedLimit > 0 ? parsedLimit : 50, 1), MAX_RUNS_PAGE);
  return RUNS
    .filter((run) => !gateway || run.gateway === gateway)
    .slice()
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .slice(0, count);
}

function acknowledgeEvent(id, user) {
  const event = EVENTS.find((candidate) => candidate.id === id);
  if (!event) return null;
  if (event.state === 'OPEN') event.state = 'ACKED';
  event.ackBy = user || 'fleet.dispatch';
  event.ackAt = new Date().toISOString();
  return event;
}

// --- read model -------------------------------------------------------------

// Runs one scheduled interval job for a healthy gateway with the clock pinned
// to `startedAt`: the same pull → decode → health → events → publish path a live
// scheduler tick takes, so account-day utilization, hours, faults and events
// advance (and roll over at account-local midnight) exactly as they would have.
function replayInterval(manifest, startedAt) {
  const random = mulberry32(Math.floor(startedAt / 1000));
  const pulled = pullMessages(manifest, startedAt);
  const decoded = decodeJ1939(manifest, pulled.messages);
  const health = computeHealth(manifest, decoded, startedAt);
  const events = evaluateEvents(health, startedAt);
  const run = {
    runId: `job-${Math.floor(random() * 0xffffffff).toString(16).padStart(8, '0')}`,
    gateway: manifest.family,
    trigger: 'scheduled',
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: null,
    durationMs: null,
    stageReached: 'publish',
    status: 'failed',
    messagesIn: pulled.messagesIn,
    assetsOut: 0,
    error: null,
  };
  return publish(manifest, health, events, run, startedAt + 640 + Math.floor(random() * 500));
}

// Start of the account-local calendar day `now` falls in.
function accountDayStart(now) {
  const day = accountDate(now);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone: ACCOUNT.timezone,
  }).formatToParts(new Date(now)).map((part) => [part.type, part.value]));
  const sinceMidnightMs = ((Number(parts.hour) * 60 + Number(parts.minute)) * 60 + Number(parts.second)) * 1000 + (now % 1000);
  let start = now - sinceMidnightMs;
  // A DST transition earlier in the day shifts the wall clock by an hour.
  while (accountDate(start - 1) === day) start -= 60 * 60 * 1000;
  while (accountDate(start) !== day) start += 60 * 60 * 1000;
  return start;
}

// With the background scheduler off (the default), healthy gateways would
// otherwise age into Not reporting purely from server uptime. Replay the interval
// jobs a running scheduler would have completed so the read model stays current:
// every job of the current account-local day (today's utilization is the sum of
// them) plus enough earlier ones to fill the job history. Jobs from days already
// over only ever fed utilization that has since reset at midnight. Gateways with
// failures (TCU-G3) are left exactly as they are.
function advanceHealthyGateways(now) {
  if (schedulerHandle) return;
  const intervalMs = INTERVAL_MIN * 60 * 1000;
  const dayStartMs = accountDayStart(now);
  Object.values(GATEWAY_MANIFESTS).forEach((manifest) => {
    if (consecutiveFailures[manifest.family]) return;
    const last = lastSuccessfulPublishes[manifest.family];
    if (!last || now - last < intervalMs + 2 * 60000) return;
    const missed = Math.floor((now - last - 2 * 60000) / intervalMs);
    if (missed < 1) return;
    const firstToday = Math.max(1, Math.ceil((dayStartMs - last) / intervalMs));
    const from = Math.max(1, Math.min(missed, firstToday) - REPLAY_HISTORY_JOBS);
    for (let index = from; index <= missed; index += 1) {
      replayInterval(manifest, last + index * intervalMs);
    }
  });
}

function isStale(asset, now) {
  return now - new Date(asset.lastReportAt).getTime() > STALE_AFTER_MS;
}

function deriveStatus(asset, now) {
  return isStale(asset, now) ? 'NOT_REPORTING' : asset.status;
}

function decorate(asset, now) {
  const stale = isStale(asset, now);
  return {
    ...asset,
    reportingStatus: deriveStatus(asset, now),
    stale,
    quality: stale ? 'STALE' : asset.quality,
    lampPriority: Object.entries(asset.lamps).filter(([, on]) => on).map(([lamp]) => LAMP_PRIORITY[lamp]).sort()[0] ?? null,
    openEvents: EVENTS.filter((event) => event.assetId === asset.assetId && event.state !== 'CLOSED').length,
  };
}

function signalsFor(asset, manifest, now) {
  const stale = isStale(asset, now);
  const map = {
    190: ['rpm', 'rpm', 'Engine Speed'],
    92: ['loadPct', '%', 'Engine Percent Load'],
    110: ['coolantC', '°C', 'Coolant Temperature'],
    100: ['oilKpa', 'kPa', 'Oil Pressure'],
    173: ['egtC', '°C', 'Exhaust Gas Temperature'],
    247: ['hours', 'h', 'Engine Total Hours'],
    183: ['fuelRateLph', 'L/h', 'Fuel Rate'],
    96: ['fuelPct', '%', 'Fuel Level'],
    168: ['battV', 'V', 'Battery Potential'],
    1761: ['defPct', '%', 'DEF Tank Level'],
  };
  const signals = [];
  manifest.pgns.forEach((pgn) => {
    const def = PGN_DECODE[pgn];
    Object.keys(def.spns).forEach((spn) => {
      const [field, unit, label] = map[spn];
      const value = field === 'hours' ? asset.hours : asset.telemetry[field];
      signals.push({
        pgn, spn: Number(spn), name: def.spns[spn], label, pgnName: def.name, value: stale || value === null ? null : value, unit, quality: stale ? 'STALE' : (value === null ? 'N/A' : 'GOOD'), timestamp: asset.lastReportAt,
      });
    });
  });
  signals.push({
    pgn: 65226, spn: null, name: 'Active DTC count', label: 'Active DTCs', pgnName: PGN_DECODE[65226].name, value: stale ? null : asset.faults.length, unit: 'count', quality: stale ? 'STALE' : 'GOOD', timestamp: asset.lastReportAt,
  });
  return signals;
}

function gatewaySummary(manifest, now) {
  const assets = Object.values(ASSETS).filter((asset) => asset.gateway === manifest.family);
  const lastPublish = lastSuccessfulPublishes[manifest.family];
  return {
    ...manifest,
    assetCount: assets.length,
    sites: [...new Set(assets.map((asset) => asset.siteName))],
    lastPublishedAt: lastPublish ? new Date(lastPublish).toISOString() : null,
    stale: !lastPublish || now - lastPublish > STALE_AFTER_MS,
    consecutiveFailures: consecutiveFailures[manifest.family] || 0,
    messagesPerInterval: assets.length * Math.max(1, Math.round((INTERVAL_MIN * 60) / manifest.reportIntervalSec)),
    decoderRegistered: Boolean(DM1_DECODERS[manifest.dm1.spnConversionMethod]),
  };
}

function sortEvents(events) {
  const severity = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  return events.slice().sort((a, b) => {
    const open = Number(b.state !== 'CLOSED') - Number(a.state !== 'CLOSED');
    return open || severity[a.severity] - severity[b.severity] || new Date(b.openedAt) - new Date(a.openedAt);
  });
}

function getFleet(now = Date.now()) {
  advanceHealthyGateways(now);
  const assets = Object.values(ASSETS).map((asset) => decorate(asset, now));
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const count = (status) => assets.filter((asset) => asset.reportingStatus === status).length;
  const sites = Object.values(SITES).map((site) => {
    const siteAssets = assets.filter((asset) => asset.site === site.code);
    return {
      ...site,
      assetCount: siteAssets.length,
      working: siteAssets.filter((asset) => asset.reportingStatus === 'WORKING').length,
      idling: siteAssets.filter((asset) => asset.reportingStatus === 'IDLING').length,
      keyOff: siteAssets.filter((asset) => asset.reportingStatus === 'KEY_OFF').length,
      notReporting: siteAssets.filter((asset) => asset.reportingStatus === 'NOT_REPORTING').length,
      openEvents: EVENTS.filter((event) => event.site === site.code && event.state !== 'CLOSED').length,
    };
  });
  const reporting = assets.filter((asset) => !asset.stale);
  return {
    account: ACCOUNT,
    generatedAt: new Date(now).toISOString(),
    intervalMinutes: INTERVAL_MIN,
    staleAfterMs: STALE_AFTER_MS,
    sites,
    gateways: Object.values(GATEWAY_MANIFESTS).map((manifest) => gatewaySummary(manifest, now)),
    assets,
    events: sortEvents(EVENTS),
    summary: {
      assetCount: assets.length,
      working: count('WORKING'),
      idling: count('IDLING'),
      keyOff: count('KEY_OFF'),
      notReporting: count('NOT_REPORTING'),
      redLamp: reporting.filter((asset) => asset.lamps.RED).length,
      amberLamp: reporting.filter((asset) => asset.lamps.AMBER && !asset.lamps.RED).length,
      derated: reporting.filter((asset) => asset.derate).length,
      serviceDue: reporting.filter((asset) => asset.serviceMeter.hoursToService <= 50).length,
      openEvents: EVENTS.filter((event) => event.state !== 'CLOSED').length,
      unackedEvents: EVENTS.filter((event) => event.state === 'OPEN').length,
      idlePct: reporting.length ? round(reporting.reduce((sum, asset) => sum + asset.utilization.idlePct, 0) / reporting.length, 1) : null,
      failedRunsLast24h: failureTimestamps.filter((timestamp) => timestamp >= dayAgo && timestamp <= now).length,
      lastRunAt: RUNS.length ? listRuns({ limit: 1 })[0].startedAt : null,
    },
  };
}

function getAsset(assetId, now = Date.now()) {
  const asset = Object.prototype.hasOwnProperty.call(ASSETS, assetId) ? ASSETS[assetId] : null;
  if (!asset) return null;
  const manifest = getGatewayManifest(asset.gateway);
  advanceHealthyGateways(now);
  return {
    asset: decorate(asset, now),
    site: SITES[asset.site],
    gateway: gatewaySummary(manifest, now),
    signals: signalsFor(asset, manifest, now),
    events: sortEvents(EVENTS.filter((event) => event.assetId === assetId || (event.assetId === null && event.gateway === asset.gateway))),
    runs: listRuns({ gateway: asset.gateway, limit: 20 }),
  };
}

function startScheduler(intervalMs = Number(process.env.X26AF2083_RUN_INTERVAL_MS) || INTERVAL_MIN * 60 * 1000) {
  stopScheduler();
  schedulerHandle = setInterval(() => {
    runAllGateways({ trigger: 'scheduled' }).catch((error) => {
      logger.error('Telematics ingest scheduler failed', { service: SERVICE, error: error.message });
    });
  }, intervalMs);
  schedulerHandle.unref();
  return schedulerHandle;
}

function stopScheduler() {
  if (schedulerHandle) clearInterval(schedulerHandle);
  schedulerHandle = null;
}

seedStore();

module.exports = {
  runPipeline,
  runAllGateways,
  listRuns,
  getFleet,
  getAsset,
  acknowledgeEvent,
  resetStore: seedStore,
  startScheduler,
  stopScheduler,
  getGatewayManifest,
  STAGES,
  SITES,
  ASSETS,
  EVENTS,
  RUNS,
};
