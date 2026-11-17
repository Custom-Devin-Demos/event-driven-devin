const path = require('path');
const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const devinSession = require('../devin-session');
const { CATALOG, ORDERS } = require('./619b204c-data');

const SERVICE = '619b204c-api';
const ROUTE = '/api/619b204c/batch/run';
const PROGRAM = { code: 'XXHX_DFI', name: 'Digital Fulfillment Interface' };
const INCIDENT_ID = 'INC0071842';
const LAST_NIGHT_REQUEST_ID = 48812345;
const TZ = 'Europe/Berlin';
const MIDDLEWARE_MODULES = ['./619b204c-fulfillment', './619b204c-middleware'];

const STATE = {};

function loadMiddleware() {
  for (const mod of MIDDLEWARE_MODULES) {
    delete require.cache[require.resolve(mod)];
  }
  return require(path.join(__dirname, '619b204c-middleware'));
}

function tzOffsetMs(at) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(at / 1000) * 1000;
}

function lastNightlySlot(now) {
  const offset = tzOffsetMs(now);
  const local = new Date(now + offset);
  let slot = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 2, 0, 0) - offset;
  if (slot > now) slot -= 86400e3;
  return slot;
}

function clock(t) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(new Date(t)).toUpperCase().replace(/ /g, '-').replace(/,-/, ' ');
}

function logHeader(req) {
  return [
    { kind: 'dim', text: '+---------------------------------------------------------------------------+' },
    { kind: 'dim', text: 'Helix Medical Systems ERP: Version : 12.2.10' },
    { kind: 'dim', text: `${PROGRAM.code} module: ${PROGRAM.name}` },
    { kind: 'dim', text: '+---------------------------------------------------------------------------+' },
    { kind: 'info', text: `Current system time is ${clock(req.startedAt)}` },
    { kind: 'info', text: `Request ID ${req.id} | Requested by ${req.requestedBy} | Responsibility: Order Management Super User` },
    { kind: 'info', text: 'Parameters: p_order_status=BOOKED p_exclude_holds=TRADE_COMPLIANCE p_endpoint=OrderToFulfillment' },
    { kind: 'dim', text: '+---------------------------------------------------------------------------+' },
  ];
}

function newRequest({ id, at, requestedBy, scheduled }) {
  return {
    id,
    program: PROGRAM.name,
    programCode: PROGRAM.code,
    scheduledAt: at,
    startedAt: at,
    completedAt: null,
    requestedBy,
    scheduled,
    phase: 'Running',
    status: 'Normal',
    processed: 0,
    total: 0,
    log: [],
  };
}

function seedCompletedRequest(id, at, count) {
  const req = newRequest({ id, at, requestedBy: 'SYSADMIN', scheduled: true });
  req.log = logHeader(req);
  req.log.push({ kind: 'info', text: `${count} booked digital order(s) selected` });
  for (let i = 0; i < count; i += 1) {
    const so = `SO-${48150 + id % 50 + i * 3}`;
    req.log.push({ kind: 'ok', text: `${so}: entitlement ENT-${so.slice(3)}-01 issued` });
  }
  req.log.push({ kind: 'info', text: `Orders processed: ${count} of ${count}` });
  req.log.push({ kind: 'ok', text: `${clock(at + 41e3)} Concurrent request completed Normal` });
  return {
    ...req, phase: 'Completed', status: 'Normal', processed: count, total: count, completedAt: at + 41e3,
  };
}

function freshOrders(runAt) {
  return ORDERS.map((o) => ({
    orderNumber: o.orderNumber,
    customer: o.customer,
    country: o.country,
    source: o.source,
    billTo: o.billTo,
    deliverTo: o.deliverTo,
    lineCount: o.lines.length,
    item: CATALOG.find((c) => c.sku === o.lines[0].sku).name,
    sku: o.lines[0].sku,
    bookedAt: runAt - o.bookedHoursBefore * 3600e3,
    status: 'BOOKED',
    holdCode: null,
    holdReason: null,
    entitlementId: null,
  }));
}

function orderSource(orderNumber) {
  return ORDERS.find((o) => o.orderNumber === orderNumber);
}

function selectOrders() {
  return STATE.orders
    .filter((o) => (o.status === 'BOOKED' || o.status === 'INTERFACE_ERROR') && o.holdCode !== 'TRADE_COMPLIANCE')
    .sort((a, b) => a.orderNumber.localeCompare(b.orderNumber));
}

function applyResult(order, result) {
  if (result.outcome === 'HOLD') {
    order.status = 'ON_HOLD';
    order.holdCode = result.holdCode;
    order.holdReason = result.reason;
    return { kind: 'warn', text: `${order.orderNumber}: hold ${result.holdCode} applied (${result.reason})` };
  }
  order.status = 'FULFILLED';
  order.holdCode = null;
  order.holdReason = null;
  order.entitlementId = result.entitlementId;
  return { kind: 'ok', text: `${order.orderNumber}: entitlement ${result.entitlementId} issued (${result.lines} lines, ${result.calls} call)` };
}

async function executeRun(req) {
  const middleware = loadMiddleware();
  const batch = selectOrders();
  req.total = batch.length;
  req.log = logHeader(req);
  req.log.push({ kind: 'info', text: `${batch.length} booked digital order(s) selected` });
  try {
    for (const order of batch) {
      req.log.push({ kind: 'info', text: `Processing ${order.orderNumber} (${order.lineCount} lines, ${order.customer}, ${order.country})` });
      const result = await middleware.sendOrder(orderSource(order.orderNumber), CATALOG);
      req.log.push(applyResult(order, result));
      req.processed += 1;
    }
    req.phase = 'Completed';
    req.status = 'Normal';
    req.completedAt = Date.now();
    req.log.push({ kind: 'info', text: `Orders processed: ${req.processed} of ${req.total}` });
    req.log.push({ kind: 'ok', text: `${clock(req.completedAt)} Concurrent request completed Normal` });
    return req;
  } catch (error) {
    const failed = STATE.orders.find((o) => o.orderNumber === error.orderNumber) || batch[req.processed];
    if (failed) {
      failed.status = 'INTERFACE_ERROR';
      failed.holdCode = 'DFI_INTERFACE_ERROR';
      failed.holdReason = error.message;
    }
    req.phase = 'Completed';
    req.status = 'Error';
    req.completedAt = Date.now();
    req.error = `${error.name}: ${error.message}`;
    req.failedOrder = failed ? failed.orderNumber : null;
    req.log.push({ kind: 'err', text: `ORA-20001: XXHX_DFI_PKG.process_order: ${error.name}: ${error.message}` });
    req.log.push({ kind: 'err', text: `${failed ? failed.orderNumber : 'order'}: hold DFI_INTERFACE_ERROR applied` });
    req.log.push({ kind: 'err', text: `Run aborted. Orders processed: ${req.processed} of ${req.total}` });
    req.log.push({ kind: 'err', text: `${clock(req.completedAt)} Concurrent request completed with status ERROR` });
    error.request = req;
    throw error;
  }
}

function resetState() {
  const now = Date.now();
  const runAt = lastNightlySlot(now);
  STATE.seededAt = now;
  STATE.dirty = false;
  STATE.running = false;
  STATE.nextRequestId = LAST_NIGHT_REQUEST_ID + 31;
  STATE.orders = freshOrders(runAt);
  for (const so of ['SO-48207', 'SO-48209']) {
    const order = STATE.orders.find((o) => o.orderNumber === so);
    order.status = 'FULFILLED';
    order.entitlementId = `ENT-${so.slice(3)}-01`;
  }
  const stuck = STATE.orders.find((o) => o.orderNumber === 'SO-48211');
  stuck.status = 'INTERFACE_ERROR';
  stuck.holdCode = 'DFI_INTERFACE_ERROR';
  stuck.holdReason = '413 Payload Too Large: max 30 lines per request (POST /license-service/v2/entitlements, order SO-48211)';

  const lastNight = newRequest({ id: LAST_NIGHT_REQUEST_ID, at: runAt, requestedBy: 'SYSADMIN', scheduled: true });
  lastNight.log = logHeader(lastNight);
  lastNight.log.push(
    { kind: 'info', text: '8 booked digital order(s) selected' },
    { kind: 'info', text: "Processing SO-48207 (2 lines, St. Brigid's University Hospital, IE)" },
    { kind: 'ok', text: 'SO-48207: entitlement ENT-48207-01 issued (2 lines, 1 call)' },
    { kind: 'info', text: 'Processing SO-48209 (4 lines, Klinikum Rheinhafen, DE)' },
    { kind: 'ok', text: 'SO-48209: entitlement ENT-48209-01 issued (4 lines, 1 call)' },
    { kind: 'info', text: 'Processing SO-48211 (48 lines, Northbridge Health Network, US)' },
    { kind: 'err', text: `ORA-20001: XXHX_DFI_PKG.process_order: FulfillmentApiError: ${stuck.holdReason}` },
    { kind: 'err', text: 'SO-48211: hold DFI_INTERFACE_ERROR applied' },
    { kind: 'err', text: 'Run aborted. Orders processed: 2 of 8' },
    { kind: 'err', text: `${clock(runAt + 19e3)} Concurrent request completed with status ERROR` },
  );
  Object.assign(lastNight, {
    phase: 'Completed', status: 'Error', processed: 2, total: 8, completedAt: runAt + 19e3,
    error: `FulfillmentApiError: ${stuck.holdReason}`, failedOrder: 'SO-48211',
  });

  STATE.requests = [
    lastNight,
    seedCompletedRequest(48801922, runAt - 86400e3, 3),
    seedCompletedRequest(48791507, runAt - 2 * 86400e3, 5),
  ];
  STATE.incident = {
    id: INCIDENT_ID,
    priority: 'P2',
    team: 'Digital Fulfillment Ops',
    status: 'New',
    openedAt: runAt + 20e3,
    requestId: LAST_NIGHT_REQUEST_ID,
    order: 'SO-48211',
    error: lastNight.error,
    pagedAt: null,
    resolvedAt: null,
  };
  STATE.notification = null;
}
resetState();

function unfulfilled() {
  return STATE.orders.filter((o) => o.status === 'BOOKED' || o.status === 'INTERFACE_ERROR');
}

function getConsoleState() {
  const now = Date.now();
  const waiting = unfulfilled();
  const oldest = waiting.reduce((min, o) => Math.min(min, o.bookedAt), Infinity);
  const latest = [...STATE.requests].sort((a, b) => b.startedAt - a.startedAt)[0];
  return {
    program: PROGRAM,
    timezone: TZ,
    tiles: {
      lastBatch: { status: latest.status, requestId: latest.id, at: latest.startedAt, processed: latest.processed, total: latest.total },
      notFulfilled: waiting.length,
      onBusinessHold: STATE.orders.filter((o) => o.holdCode === 'TRADE_COMPLIANCE').length,
      oldestWaitingHours: Number.isFinite(oldest) ? Math.round(((now - oldest) / 3600e3) * 10) / 10 : 0,
      oldestTargetHours: 4,
      openIncidents: STATE.incident && STATE.incident.status !== 'Resolved' ? 1 : 0,
    },
    requests: [...STATE.requests].sort((a, b) => b.startedAt - a.startedAt).map(({ log, ...r }) => ({ ...r, logLines: log.length })),
    orders: [...STATE.orders].sort((a, b) => a.orderNumber.localeCompare(b.orderNumber)),
    catalog: CATALOG,
    incident: STATE.incident,
    notification: STATE.notification,
    running: STATE.running,
    dirty: STATE.dirty,
    now,
  };
}

function getRequestLog(id) {
  const req = STATE.requests.find((r) => String(r.id) === String(id));
  return req ? { id: req.id, status: req.status, log: req.log } : null;
}

function getOrderPayload(orderNumber) {
  const order = orderSource(orderNumber);
  if (!order) return null;
  return loadMiddleware().buildRequest(order);
}

function boundaryOrder(lineCount) {
  const base = orderSource('SO-48211');
  const lines = [];
  for (let i = 0; i < lineCount; i += 1) {
    const src = base.lines[i % base.lines.length];
    lines.push({ ...src, lineNumber: i + 1, siteId: `TST-${String(i + 1).padStart(3, '0')}` });
  }
  return { ...base, orderNumber: `TEST-${lineCount}L`, customer: 'Boundary test (synthetic)', lines };
}

async function sendTestRequest({ orderNumber, lineCount }) {
  const n = Number(lineCount);
  const order = orderNumber ? orderSource(orderNumber) : (Number.isInteger(n) && n > 0 && n <= 200 ? boundaryOrder(n) : null);
  if (!order) {
    const err = new Error('Unknown order or line count');
    err.statusCode = 404;
    throw err;
  }
  const middleware = loadMiddleware();
  const request = middleware.buildRequest(order);
  const started = Date.now();
  try {
    const result = await middleware.sendOrder(order, CATALOG);
    return {
      ok: true, orderNumber: order.orderNumber, requestLines: request.lines.length, durationMs: Date.now() - started, result,
      status: result.outcome === 'HOLD' ? 'HOLD' : 200,
    };
  } catch (error) {
    return {
      ok: false, orderNumber: order.orderNumber, requestLines: request.lines.length, durationMs: Date.now() - started,
      status: error.status || 500, error: `${error.name}: ${error.message}`,
    };
  }
}

const PROMPT_APPENDIX = [
  `On-call incident ${INCIDENT_ID} (P2, Digital Fulfillment Ops). The nightly ${PROGRAM.name} concurrent request (${PROGRAM.code}) ended in ERROR. Order SO-48211 is stuck on hold DFI_INTERFACE_ERROR and the run aborted, so 6 booked digital orders were not fulfilled: SO-48211, SO-48213, SO-48216, SO-48218, SO-48220, SO-48223.`,
  'Repository: COG-GTM/event-driven-devin. It is a mock, no real customer systems: the ERP test-instance console and the batch job are app/services/verticals/619b204c.js (order data in 619b204c-data.js), the OrderToFulfillment middleware is app/services/verticals/619b204c-middleware.js and the downstream license/entitlement API is app/services/verticals/619b204c-fulfillment.js.',
  'Handle this end to end:',
  '1. Start the console (npm start, then open http://localhost:3000/619b204c; it stands in for the Oracle test instance). Investigate through its API and logs first (GET /api/619b204c/state, GET /api/619b204c/requests/<id>/log), the way you would use read-only SQL or REST against Oracle, then reproduce with npm run replay:619b204c -- SO-48211.',
  '2. Find the root cause and explain why it started failing now.',
  '3. Fix it so every order either fulfills or lands on the correct business hold. Never bypass the trade compliance check and do not raise the downstream API limit. Add a regression test in tests/619b204c-*.test.js and run npx jest tests/619b204c (update harness tests that assert the old failure).',
  '4. Show the replay going from failure to success, then rerun the batch on the test instance through the harness API (POST /api/619b204c/test-instance/rerun) and confirm every affected order is fulfilled or on a legitimate hold. Do not click "Run nightly batch now", it pages on-call. Record it in the browser: before (red console, failed request log, the stuck 48-line order), Send test request FAIL then PASS including the 30- and 31-line boundary requests, the rerun turning the console green, SO-48216 still on the TRADE_COMPLIANCE hold, and the PR.',
  `5. Write the resolution note at docs/619b204c/incidents/${INCIDENT_ID}.md using docs/619b204c/incidents/TEMPLATE.md.`,
  '6. Open a pull request for IT review. Do not merge it: production changes need IT approval.',
  '7. Reply in the incident thread with the root cause, the fix, the orders recovered and the PR link, in plain language for the fulfillment team.',
].join('\n');

function alertDataFor(error, data, requestId, req) {
  return {
    title: `${INCIDENT_ID} · ${PROGRAM.name} request ${req.id} ended in ERROR`,
    issueTitle: `${error.name}: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved%20service%3A${SERVICE}`,
    culprit: 'app/services/verticals/619b204c.js — runNightlyBatch',
    errorType: error.name || 'Error',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: `${PROGRAM.name} (${PROGRAM.code}) · ${INCIDENT_ID}`,
    slackMemberId: 'U0BDHHQUM24',
    skipVulnerablePr: true,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'concurrent_request', value: String(req.id) },
      { key: 'program', value: PROGRAM.code },
      { key: 'order', value: req.failedOrder || '' },
      { key: 'incident', value: INCIDENT_ID },
    ],
    promptAppendix: PROMPT_APPENDIX,
    extra: {
      requestId, concurrentRequest: req.id, failedOrder: req.failedOrder, processed: `${req.processed} of ${req.total}`,
      notFulfilled: unfulfilled().map((o) => o.orderNumber),
    },
    level: 'error',
    platform: 'node',
    firstSeen: '',
    lastSeen: new Date().toISOString(),
    count: '',
    shortId: '',
    project: 'event-driven-devin',
    release: process.env.SENTRY_RELEASE || 'order-to-fulfillment@4.3.1',
    environment: process.env.DD_ENV || 'prod',
    triggeredRule: `${PROGRAM.code} concurrent request ended in ERROR`,
  };
}

function devinPromptFor(alertData) {
  return typeof devinSession.buildPrompt === 'function' ? devinSession.buildPrompt(alertData) : PROMPT_APPENDIX;
}

async function startRun(requestedBy) {
  if (STATE.running) {
    const err = new Error('A Digital Fulfillment Interface request is already running');
    err.statusCode = 409;
    throw err;
  }
  STATE.running = true;
  STATE.dirty = true;
  const req = newRequest({ id: STATE.nextRequestId, at: Date.now(), requestedBy, scheduled: false });
  STATE.nextRequestId += 7;
  STATE.requests.push(req);
  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 110));
    return await executeRun(req);
  } finally {
    STATE.running = false;
  }
}

async function runNightlyBatch(data = {}) {
  const startTime = Date.now();
  const requestId = uuidv4();
  logger.info('Digital Fulfillment Interface submitted', { requestId, program: PROGRAM.code, service: SERVICE });
  try {
    const req = await startRun('OPS_PRESENTER');
    incrementMetric('dfi.batch.success', { route: ROUTE });
    recordTiming('dfi.batch.latency', Date.now() - startTime, { route: ROUTE });
    if (STATE.incident && STATE.incident.status !== 'Resolved') {
      STATE.incident.status = 'Resolved';
      STATE.incident.resolvedAt = Date.now();
    }
    return { success: true, requestId, request: { ...req, log: undefined }, ...getConsoleState() };
  } catch (error) {
    if (error.statusCode === 409) throw error;
    const duration = Date.now() - startTime;
    const req = error.request || {};
    incrementMetric('dfi.batch.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('dfi.batch.latency', duration, { route: ROUTE, error: 'true' });
    logger.error('Digital Fulfillment Interface ended in error', {
      requestId, error: error.message, errorClass: error.name, concurrentRequest: req.id, failedOrder: req.failedOrder, durationMs: duration, service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, program: PROGRAM.code, alert_path: 'instant' },
      extra: { requestId, concurrentRequest: req.id, failedOrder: req.failedOrder },
    });

    const incident = STATE.incident;
    incident.requestId = req.id;
    incident.error = req.error;
    if (!incident.pagedAt) {
      incident.pagedAt = Date.now();
      incident.status = 'In progress';
      const alertData = alertDataFor(error, data, requestId, req);
      STATE.notification = { status: 'pending', detail: 'Posting alert to Slack and starting Devin', prompt: devinPromptFor(alertData) };
      devinSession.createSessionAndAlert(alertData).then((result) => {
        const url = result && result.session && result.session.url;
        STATE.notification = {
          ...STATE.notification,
          status: url ? 'sent' : 'skipped',
          detail: url ? 'Alert posted to Slack, Devin session started' : 'Alert not delivered (Slack/Devin not configured or session cap reached)',
          sessionUrl: url || null,
        };
      }).catch((err) => {
        STATE.notification = { ...STATE.notification, status: 'error', detail: err.message };
        logger.error('Failed to trigger Devin session', { error: err.message });
      });
    }
    throw error;
  }
}

async function rerunOnTestInstance() {
  const req = await startRun('DFI_TEST_HARNESS').catch((error) => {
    if (error.statusCode === 409 || !error.request) throw error;
    logger.warn('Test-instance rerun ended in error', { error: error.message, concurrentRequest: error.request.id, service: SERVICE });
    return error.request;
  });
  if (req.status === 'Normal' && STATE.incident && STATE.incident.status !== 'Resolved') {
    STATE.incident.status = 'Resolved';
    STATE.incident.resolvedAt = Date.now();
  }
  return { success: req.status === 'Normal', request: { ...req, log: undefined }, ...getConsoleState() };
}

function resetDemo() {
  const cleared = STATE.requests.length - 3;
  resetState();
  logger.info('Demo state reset', { cleared, service: SERVICE });
  incrementMetric('dfi.reset', { route: `${ROUTE}/reset` });
  return { success: true, cleared, ...getConsoleState() };
}

module.exports = {
  runNightlyBatch,
  rerunOnTestInstance,
  resetDemo,
  sendTestRequest,
  getConsoleState,
  getRequestLog,
  getOrderPayload,
  INCIDENT_ID,
  CATALOG,
  ORDERS,
};
