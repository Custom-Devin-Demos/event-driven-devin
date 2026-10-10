const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'dc-wave-release';
const ROUTE = '/api/fb76423f/waves/:waveId/release';
const ONCALL_SLACK_MEMBER_ID = 'U0BQZBHCNMA';
const SENTRY_ISSUE_QUERY = 'is:unresolved allocatable';

const DC = {
  id: 'DC 41',
  name: 'Marlow Junction Distribution Center',
  shift: '2nd shift · 14:00–22:30',
  wmsFeed: 'WMS LOCSTATE v3',
  snapshotAsOf: '05:00 cycle snapshot',
};

const ITEMS = {
  21447803: { sku: '21447803', description: 'Clover Valley Paper Towels, 6 Mega Rolls', pack: '4/6 ct' },
  21447911: { sku: '21447911', description: 'Clover Valley Bath Tissue, 12 Double Rolls', pack: '4/12 ct' },
  30518206: { sku: '30518206', description: 'DG Home Ultra Bleach, 81 oz', pack: '6/81 oz' },
  30518422: { sku: '30518422', description: 'Clover Valley Purified Water, 24 pk 16.9 oz', pack: '1/24 pk' },
  40229107: { sku: '40229107', description: 'Clover Valley Frosted Wheat Cereal, 18 oz', pack: '12/18 oz' },
  40229315: { sku: '40229315', description: 'Clover Valley Creamy Peanut Butter, 40 oz', pack: '12/40 oz' },
  50611208: { sku: '50611208', description: 'DG Body Antibacterial Hand Soap, 7.5 oz', pack: '12/7.5 oz' },
  50611474: { sku: '50611474', description: 'DG Home Tall Kitchen Bags, 13 gal, 40 ct', pack: '6/40 ct' },
};

/**
 * Slot master from the overnight cycle snapshot. Each SKU is picked from its
 * primary pick slot first, then from reserve. `onHandCases` is the quantity on
 * hand at snapshot time.
 */
const SLOTS = {
  'A-14-03-B': { location: 'A-14-03-B', sku: '21447803', zone: 'PICK', module: 'PM1', onHandCases: 64 },
  'R-22-05-C': { location: 'R-22-05-C', sku: '21447803', zone: 'RESERVE', module: 'PM1', onHandCases: 96 },
  'A-14-07-A': { location: 'A-14-07-A', sku: '21447911', zone: 'PICK', module: 'PM1', onHandCases: 120 },
  'A-09-02-C': { location: 'A-09-02-C', sku: '30518206', zone: 'PICK', module: 'PM3', onHandCases: 18 },
  'R-31-01-A': { location: 'R-31-01-A', sku: '30518206', zone: 'RESERVE', module: 'PM3', onHandCases: 84 },
  'F-02-01-A': { location: 'F-02-01-A', sku: '30518422', zone: 'PICK', module: 'PM3', onHandCases: 210 },
  'B-05-04-D': { location: 'B-05-04-D', sku: '40229107', zone: 'PICK', module: 'PM2', onHandCases: 72 },
  'B-05-06-B': { location: 'B-05-06-B', sku: '40229315', zone: 'PICK', module: 'PM2', onHandCases: 60 },
  'B-11-02-A': { location: 'B-11-02-A', sku: '50611208', zone: 'PICK', module: 'PM2', onHandCases: 48 },
  'R-18-03-B': { location: 'R-18-03-B', sku: '50611208', zone: 'RESERVE', module: 'PM2', onHandCases: 40 },
  'A-17-01-C': { location: 'A-17-01-C', sku: '50611474', zone: 'PICK', module: 'PM1', onHandCases: 90 },
};

const SLOTS_BY_SKU = Object.values(SLOTS).reduce((acc, slot) => {
  (acc[slot.sku] = acc[slot.sku] || []).push(slot);
  return acc;
}, {});
Object.values(SLOTS_BY_SKU).forEach((slots) => slots.sort((a, b) => (a.zone === 'PICK' ? -1 : 1) - (b.zone === 'PICK' ? -1 : 1)));

const PICK_MODULES = {
  PM1: { id: 'PM1', name: 'Pick Module 1', type: 'Full case · conveyor' },
  PM2: { id: 'PM2', name: 'Pick Module 2', type: 'Split case · pick-to-light' },
  PM3: { id: 'PM3', name: 'Pick Module 3', type: 'Bulk · floor pallet' },
};

/**
 * Current location state as reported by the WMS location-state feed. The cycle
 * snapshot above is what planners preview against; release re-checks every
 * candidate slot against this feed before building pick tasks.
 */
const LOCATION_STATE_FEED = {
  'A-14-03-B': { stateCode: 'STAGED_FOR_SHIP', lane: 'SHIP-LANE-12', updatedAt: '13:52' },
  'R-22-05-C': { stateCode: 'AVAILABLE', updatedAt: '05:00' },
  'A-14-07-A': { stateCode: 'AVAILABLE', updatedAt: '05:00' },
  'A-09-02-C': { stateCode: 'CYCLE_COUNT', updatedAt: '13:20' },
  'R-31-01-A': { stateCode: 'AVAILABLE', updatedAt: '05:00' },
  'F-02-01-A': { stateCode: 'AVAILABLE', updatedAt: '05:00' },
  'B-05-04-D': { stateCode: 'AVAILABLE', updatedAt: '05:00' },
  'B-05-06-B': { stateCode: 'REPLEN_PENDING', updatedAt: '12:41' },
  'B-11-02-A': { stateCode: 'HOLD', updatedAt: '11:05' },
  'R-18-03-B': { stateCode: 'AVAILABLE', updatedAt: '05:00' },
  'A-17-01-C': { stateCode: 'AVAILABLE', updatedAt: '05:00' },
};

/**
 * How each WMS location state affects allocation. `physicalZone` is set when
 * the state means the goods are no longer where the slot master says they are.
 */
const LOCATION_STATE_RULES = {
  AVAILABLE: { allocatable: true, label: 'Available' },
  REPLEN_PENDING: { allocatable: true, label: 'Replenishment pending' },
  CYCLE_COUNT: { allocatable: false, label: 'Cycle count in progress' },
  HOLD: { allocatable: false, label: 'Quality hold' },
  DAMAGED: { allocatable: false, label: 'Damaged' },
};

function storeOrders(stores, skuQty) {
  return stores.map((store, i) => ({
    store,
    lines: Object.entries(skuQty).map(([sku, base]) => ({ sku, cases: base + ((i * 3 + sku.length) % 3) })),
  }));
}

const WAVES = {
  'W41-1009-03': {
    waveId: 'W41-1009-03',
    route: 'Route 114 · Upper Cumberland',
    door: '12',
    trailer: 'DG 418226',
    departure: '16:30',
    deliveryDay: 'Saturday',
    status: 'PLANNED',
    orders: storeOrders(
      ['20417', '20433', '20458', '20462', '20519', '20540', '20577', '20581', '20604', '20622', '20649', '20675', '20688', '20702'],
      { 21447803: 3, 21447911: 4, 30518206: 2, 40229107: 2, 40229315: 1, 50611474: 2 },
    ),
  },
  'W41-1009-04': {
    waveId: 'W41-1009-04',
    route: 'Route 117 · Lake Barkley',
    door: '14',
    trailer: 'DG 418391',
    departure: '17:45',
    deliveryDay: 'Saturday',
    status: 'PLANNED',
    orders: storeOrders(
      ['21105', '21118', '21136', '21142', '21170', '21184', '21197', '21203', '21231', '21256'],
      { 21447911: 3, 30518422: 4, 40229107: 2, 50611208: 2 },
    ),
  },
  'W41-1009-05': {
    waveId: 'W41-1009-05',
    route: 'Route 121 · Duck River',
    door: '15',
    trailer: 'DG 418407',
    departure: '19:15',
    deliveryDay: 'Sunday',
    status: 'PLANNED',
    orders: storeOrders(
      ['21402', '21419', '21427', '21455', '21468', '21490', '21511', '21534'],
      { 30518422: 5, 40229315: 2, 50611474: 3 },
    ),
  },
};

const DOORS = [
  { door: '10', trailer: 'DG 417988', status: 'DEPARTED', detail: 'Route 109 · departed 13:40' },
  { door: '11', trailer: 'DG 418102', status: 'LOADING', detail: 'Route 112 · 82% loaded' },
  { door: '12', trailer: 'DG 418226', status: 'CHECKED_IN', detail: 'Route 114 · awaiting W41-1009-03' },
  { door: '13', trailer: null, status: 'OPEN', detail: 'No trailer' },
  { door: '14', trailer: 'DG 418391', status: 'CHECKED_IN', detail: 'Route 117 · awaiting W41-1009-04' },
  { door: '15', trailer: 'DG 418407', status: 'CHECKED_IN', detail: 'Route 121 · awaiting W41-1009-05' },
  { door: '16', trailer: 'VND 55120', status: 'INBOUND', detail: 'Vendor receipt · unloading' },
];

const REMEDIATION_DIRECTIVE = `Repository: COG-GTM/event-driven-devin. Scope: only the DC 41 outbound wave release failure below. This repository hosts many independent verticals, each with its own open Sentry issues and background traffic (for example POST /api/banking/transfer and POST /api/storefront/checkout). Ignore every issue that is not from POST /api/fb76423f/waves/<waveId>/release and do not modify any other vertical.

The failing surface is the Dollar General Distribution Center Operations wave release console at app/public/verticals/fb76423f.html (served at /dollar-general-dc and /fb76423f). Its "Release wave" button posts to the route in app/routes/verticals/fb76423f.js. The release pipeline lives in app/services/verticals/fb76423f.js: releaseWave -> buildPickTasks -> normalizeLocationState. Wave W41-1009-03 fails while every other wave releases. The WMS location-state feed now reports slot A-14-03-B as STAGED_FOR_SHIP: the paper towels allocated from that pick slot have physically been moved to the shipping lane, while the cycle snapshot still shows 64 cases in the pick slot. normalizeLocationState has no rule for that state code, so it returns undefined and buildPickTasks throws when it reads the allocatable flag.

Fix it so the system matches the floor: add a STAGED_FOR_SHIP rule that is not allocatable and records the physical zone as the shipping lane, so that inventory is excluded from allocation and the wave allocates from reserve instead. The discrepancy must be returned in the release response's inventoryExceptions list (the console already renders it) for warehouse follow-up; do not adjust on-hand quantities in code. Any location state code that has no rule must fail the release as a handled 409 UNKNOWN_LOCATION_STATE error naming the code and location (no alert), never a TypeError. Keep the console's look and feel unchanged. Verify by starting the server (node app/server.js) and POSTing to /api/fb76423f/waves/W41-1009-03/release, which must return status RELEASED with one inventory exception for A-14-03-B, confirm waves W41-1009-04 and W41-1009-05 still release, add a regression test under tests/, and run npm test and npm run lint.

Reproduce before you diagnose. Your first action after reading the alert, before reading any source file, is to start the server, open /dollar-general-dc?repro=1 in a real browser with your screen recording running and click through Preview allocation -> Confirm -> Release wave for W41-1009-03, so the recording shows the wave halting. Always use ?repro=1 for your own runs: the release fails identically but raises no Sentry event, Slack alert or Devin session. If it does not reproduce, stop and report that instead of fixing anything.

After the fix, repeat the same /dollar-general-dc?repro=1 browser flow with a second recording, showing the wave released and the A-14-03-B inventory exception. Attach both (an animated webp of the reproduction under a "Reproduction" heading, and an animated webp of the post-fix run plus a screenshot of the released wave under a "Fix Verification" heading) to the pull request and post the same evidence as a PR comment. Do not mark the fix complete until both recordings are attached.`;

function handledError(name, message, code, statusCode) {
  const error = new Error(message);
  error.name = name;
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function findWave(waveId) {
  const wave = Object.hasOwn(WAVES, String(waveId)) ? WAVES[waveId] : undefined;
  if (!wave) throw handledError('ValidationError', `Unknown wave: ${waveId || '(none)'}`, 'UNKNOWN_WAVE', 404);
  return wave;
}

function demandBySku(wave) {
  const demand = {};
  wave.orders.forEach(({ store, lines }) => {
    lines.forEach(({ sku, cases }) => {
      (demand[sku] = demand[sku] || []).push({ store, cases });
    });
  });
  return demand;
}

function waveTotals(wave) {
  let cases = 0;
  let lines = 0;
  wave.orders.forEach((o) => o.lines.forEach((l) => { cases += l.cases; lines += 1; }));
  return { stores: wave.orders.length, lines, cases };
}

function summarizeWave(wave) {
  return {
    waveId: wave.waveId,
    route: wave.route,
    door: wave.door,
    trailer: wave.trailer,
    departure: wave.departure,
    deliveryDay: wave.deliveryDay,
    status: wave.status,
    ...waveTotals(wave),
  };
}

function getBoard() {
  return {
    dc: DC,
    waves: Object.values(WAVES).map(summarizeWave),
    doors: DOORS,
    pickModules: Object.values(PICK_MODULES),
  };
}

/**
 * Allocation preview against the cycle snapshot: each SKU is planned against
 * its primary pick slot. Live location state is applied at release.
 */
function previewAllocation(waveId) {
  const wave = findWave(waveId);
  const demand = demandBySku(wave);
  const rows = Object.entries(demand).map(([sku, stores]) => {
    const primary = SLOTS_BY_SKU[sku][0];
    const cases = stores.reduce((sum, s) => sum + s.cases, 0);
    return {
      sku,
      description: ITEMS[sku].description,
      pack: ITEMS[sku].pack,
      stores: stores.length,
      cases,
      location: primary.location,
      module: primary.module,
      onHandCases: primary.onHandCases,
      coverage: primary.onHandCases >= cases ? 'FULL' : 'PRIMARY_PLUS_RESERVE',
    };
  });
  return { wave: summarizeWave(wave), snapshotAsOf: DC.snapshotAsOf, rows };
}

function normalizeLocationState(stateCode) {
  return LOCATION_STATE_RULES[String(stateCode || '').toUpperCase()];
}

function buildPickTasks(wave, locationFeed) {
  const demand = demandBySku(wave);
  const tasks = [];
  const shorts = [];
  const inventoryExceptions = [];
  let seq = 1;

  Object.entries(demand).forEach(([sku, stores]) => {
    const remaining = SLOTS_BY_SKU[sku].map((slot) => ({ slot, cases: slot.onHandCases }));
    const usable = remaining.filter(({ slot }) => {
      const reported = locationFeed[slot.location] || {};
      const state = normalizeLocationState(reported.stateCode);
      if (!state.allocatable) {
        if (state.physicalZone && state.physicalZone !== slot.zone) {
          inventoryExceptions.push({
            location: slot.location,
            sku,
            description: ITEMS[sku].description,
            systemState: `${slot.zone === 'PICK' ? 'Pick slot' : 'Reserve'} · ${slot.onHandCases} cases on hand (${DC.snapshotAsOf})`,
            physicalState: `${state.label}${reported.lane ? ` · ${reported.lane}` : ''} (feed ${reported.updatedAt || 'n/a'})`,
            action: 'Excluded from allocation. Inventory control to reconcile slot and confirm staged pallets.',
          });
        }
        return false;
      }
      return true;
    });

    stores.forEach(({ store, cases }) => {
      let need = cases;
      usable.forEach((entry) => {
        if (need <= 0 || entry.cases <= 0) return;
        const take = Math.min(need, entry.cases);
        entry.cases -= take;
        need -= take;
        tasks.push({
          taskId: `${wave.waveId}-T${String(seq++).padStart(3, '0')}`,
          store,
          sku,
          location: entry.slot.location,
          module: entry.slot.module,
          cases: take,
        });
      });
      if (need > 0) shorts.push({ store, sku, casesShort: need });
    });
  });

  return { tasks, shorts, inventoryExceptions };
}

function summarizeTasks(tasks) {
  const byModule = {};
  Object.keys(PICK_MODULES).forEach((id) => { byModule[id] = { tasks: 0, cases: 0 }; });
  tasks.forEach((t) => { byModule[t.module].tasks += 1; byModule[t.module].cases += t.cases; });
  return byModule;
}

function haltImpact(wave) {
  const totals = waveTotals(wave);
  return {
    waveId: wave.waveId,
    status: 'HALTED',
    door: wave.door,
    trailer: wave.trailer,
    departure: wave.departure,
    deliveryDay: wave.deliveryDay,
    storesAtRisk: totals.stores,
    casesUnreleased: totals.cases,
    linesUnreleased: totals.lines,
    pickModulesIdle: [...new Set(wave.orders.flatMap((o) => o.lines.map((l) => SLOTS_BY_SKU[l.sku][0].module)))].sort(),
  };
}

async function releaseWave(data) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const wave = findWave(data.waveId);
  if (data.confirmed !== true) {
    throw handledError('ValidationError', 'Confirm the allocation preview before releasing', 'NOT_CONFIRMED', 400);
  }

  logger.info('Releasing outbound wave', {
    requestId,
    waveId: wave.waveId,
    door: wave.door,
    trailer: wave.trailer,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    const { tasks, shorts, inventoryExceptions } = buildPickTasks(wave, LOCATION_STATE_FEED);
    const duration = Date.now() - startTime;
    incrementMetric('dc_wave_release.success', { route: ROUTE, waveId: wave.waveId, dc: 'DC41' });
    recordTiming('dc_wave_release.latency', duration, { route: ROUTE });

    return {
      success: true,
      requestId,
      wave: { ...summarizeWave(wave), status: 'RELEASED' },
      releasedAt: new Date().toISOString(),
      pickTasks: tasks.length,
      casesReleased: tasks.reduce((sum, t) => sum + t.cases, 0),
      byModule: summarizeTasks(tasks),
      sampleTasks: tasks.slice(0, 8),
      shorts,
      inventoryExceptions,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    if (error.statusCode && error.statusCode < 500) {
      error.requestId = requestId;
      throw error;
    }

    const impact = haltImpact(wave);
    incrementMetric('dc_wave_release.failure', { route: ROUTE, waveId: wave.waveId, errorClass: error.name, dc: 'DC41' });
    recordTiming('dc_wave_release.latency', duration, { route: ROUTE, error: 'true' });

    const context = {
      requestId,
      dc: DC.id,
      waveId: wave.waveId,
      route: wave.route,
      door: wave.door,
      trailer: wave.trailer,
      storesAtRisk: impact.storesAtRisk,
      casesUnreleased: impact.casesUnreleased,
      locationFeed: DC.wmsFeed,
    };

    logger.error('Wave release failed while building pick tasks', {
      ...context,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: SERVICE,
    });

    error.requestId = requestId;
    error.impact = impact;

    if (data.synthetic) {
      logger.info('Reproduction run — wave release failed without raising Sentry, Slack or a Devin session', { requestId, waveId: wave.waveId });
      throw error;
    }

    const tags = { route: ROUTE, service: SERVICE, dc: 'DC41', waveId: wave.waveId, door: wave.door };
    Sentry.captureException(error, { tags, extra: context });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=${encodeURIComponent(SENTRY_ISSUE_QUERY)}`,
      culprit: 'app/services/verticals/fb76423f.js — buildPickTasks',
      errorType: error.name || 'Error',
      errorValue: error.message,
      service: SERVICE,
      verticalLabel: 'Dollar General DC 41 — Outbound wave release',
      customer: 'fb76423f',
      slackMemberId: ONCALL_SLACK_MEMBER_ID,
      slackMemberIdFallback: ONCALL_SLACK_MEMBER_ID,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
      extra: context,
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@1.0.0`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to raise alert for wave release failure', { requestId, error: alertError.message });
    });

    throw error;
  }
}

module.exports = {
  getBoard,
  previewAllocation,
  releaseWave,
  buildPickTasks,
  normalizeLocationState,
  LOCATION_STATE_RULES,
  LOCATION_STATE_FEED,
  SLOTS,
  WAVES,
  REMEDIATION_DIRECTIVE,
};
