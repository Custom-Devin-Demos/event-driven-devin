const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const seed = require('./b6e7eac1-seed');

/**
 * Rental-return integration service (slug b6e7eac1).
 *
 * Consumes equipment-return events published by the rental storefront and applies
 * them to rental contract lines in the dealer ERP (Dynamics 365 F&O) so the dealer
 * can stop the rental clock and invoice. Events that cannot be applied are parked
 * on the dead-letter queue with the reason and the full message.
 *
 * The Service Bus topic, its dead-letter queue, the F&O OData client and the
 * Azure Monitor alert rule are all simulated in process. Firing the alert goes through
 * createSessionAndAlert like every other demo: the Slack alert and the Devin session are real.
 */

const SERVICE = 'b6e7eac1-api';
const ROUTE_BASE = '/api/b6e7eac1';
const ALERT_RULE = 'converge-rentalsync-deadletter-count';
const FIRE_ROUTE = `${ROUTE_BASE}/alerts/fire`;
const SLACK_MEMBER_ID = 'U0BDHHQUM24';

const ERROR_CODES = {
  DEALER_UNKNOWN: 'DEALER_UNKNOWN',
  WAREHOUSE_UNMAPPED: 'WAREHOUSE_UNMAPPED',
  CONTRACT_NOT_FOUND: 'CONTRACT_NOT_FOUND',
  CONTRACT_NOT_ON_RENT: 'CONTRACT_NOT_ON_RENT',
};

class ReturnMappingError extends Error {
  constructor(errorCode, message) {
    super(message);
    this.name = 'ReturnMappingError';
    this.errorCode = errorCode;
  }
}

class ValidationError extends Error {
  constructor(message, errors) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
    this.errors = errors;
  }
}

// ---- in-memory world ----------------------------------------------------------------------------

/** (dataAreaId, contractId) → contract line. Stand-in for the RentalContractLines entity. */
const contractLines = new Map();
/** eventId → dead letter. Stand-in for the subscription's $DeadLetterQueue. */
const deadLetters = new Map();
let lastResetAt = null;
let lastAlert = null;
let alertInFlight = false;

function lineKey(dataAreaId, contractId) {
  return `${String(dataAreaId).toLowerCase()}|${String(contractId).toUpperCase()}`;
}

// ---- mapping ------------------------------------------------------------------------------------

function knownDealerCodes() {
  return seed.DEALERS.map((d) => d.dealerCode).sort();
}

function resolveDealer(dealerCode) {
  const code = String(dealerCode || '').trim().toUpperCase();
  if (!code) {
    throw new ReturnMappingError(ERROR_CODES.DEALER_UNKNOWN, 'Dealer code is missing on the return event.');
  }
  const dealer = seed.DEALERS.find((d) => d.dealerCode === code);
  if (!dealer) {
    throw new ReturnMappingError(
      ERROR_CODES.DEALER_UNKNOWN,
      `Dealer code '${dealerCode}' is not in the dealer directory (known: ${knownDealerCodes().join(', ')}).`,
    );
  }
  return dealer;
}

function resolveWarehouse(dataAreaId, returnYard) {
  const yards = seed.WAREHOUSE_MAP[String(dataAreaId).toLowerCase()];
  if (!yards) {
    throw new ReturnMappingError(ERROR_CODES.WAREHOUSE_UNMAPPED, `No branch→warehouse map exists for legal entity '${dataAreaId}'.`);
  }
  const yard = String(returnYard || '').trim().toUpperCase();
  const warehouseId = yards[yard];
  if (!warehouseId) {
    throw new ReturnMappingError(
      ERROR_CODES.WAREHOUSE_UNMAPPED,
      `Return yard '${returnYard}' has no F&O warehouse mapping for legal entity '${dataAreaId}' (mapped yards: ${Object.keys(yards).sort().join(', ')}).`,
    );
  }
  return warehouseId;
}

/** Turns an inbound return event into the ContractReturn the ERP client can apply. */
function mapReturnEvent(evt) {
  const dealer = resolveDealer(evt.dealerCode);
  const returnWarehouseId = resolveWarehouse(dealer.dataAreaId, evt.returnYard);
  const warnings = [];
  let fuelPercent = evt.fuelPercent;
  if (fuelPercent < 0 || fuelPercent > 100) {
    warnings.push(`fuelPercent ${fuelPercent} is outside 0–100; clamped before writing to F&O.`);
    fuelPercent = Math.min(100, Math.max(0, fuelPercent));
  }
  return {
    dataAreaId: dealer.dataAreaId,
    contractId: evt.contractId,
    returnWarehouseId,
    hoursMeter: evt.hoursMeter,
    fuelPercent,
    returnedAt: evt.returnedAt,
    warnings,
  };
}

// ---- in-memory D365 client ----------------------------------------------------------------------

function listContractLines(dataAreaId) {
  const id = String(dataAreaId).toLowerCase();
  return [...contractLines.values()]
    .filter((l) => l.dataAreaId === id)
    .sort((a, b) => a.contractId.localeCompare(b.contractId));
}

function getContractLine(dataAreaId, contractId) {
  return contractLines.get(lineKey(dataAreaId, contractId)) || null;
}

function applyReturn(contractReturn) {
  const key = lineKey(contractReturn.dataAreaId, contractReturn.contractId);
  const line = contractLines.get(key);
  if (!line) {
    throw new ReturnMappingError(
      ERROR_CODES.CONTRACT_NOT_FOUND,
      `Contract line '${contractReturn.contractId}' does not exist in legal entity '${contractReturn.dataAreaId}'.`,
    );
  }
  if (line.state !== 'OnRent') {
    throw new ReturnMappingError(
      ERROR_CODES.CONTRACT_NOT_ON_RENT,
      `Contract line '${contractReturn.contractId}' is ${line.state}, not OnRent; return cannot be applied twice.`,
    );
  }
  const updated = {
    ...line,
    state: 'Returned',
    returnWarehouseId: contractReturn.returnWarehouseId,
    returnHoursMeter: contractReturn.hoursMeter,
    returnFuelPercent: contractReturn.fuelPercent,
    returnedAt: contractReturn.returnedAt,
  };
  contractLines.set(key, updated);
  return updated;
}

// ---- processing ---------------------------------------------------------------------------------

function parkDeadLetter(evt, error) {
  const existing = deadLetters.get(evt.eventId);
  const deadLetter = {
    eventId: evt.eventId,
    errorCode: error.errorCode,
    reason: error.message,
    enqueuedAt: existing ? existing.enqueuedAt : new Date().toISOString(),
    deliveryCount: (existing ? existing.deliveryCount : 0) + 1,
    body: evt,
  };
  deadLetters.set(evt.eventId, deadLetter);
  return deadLetter;
}

/**
 * Apply one return event, or park it on the dead-letter queue with the reason.
 * `report` controls whether a dead letter is also sent to Sentry (user-initiated
 * ingest and replays are; the seed run on boot/reset is not).
 */
async function processReturnEvent(evt, { report = true } = {}) {
  const startTime = Date.now();
  try {
    const mapped = mapReturnEvent(evt);
    const line = applyReturn(mapped);
    for (const warning of mapped.warnings) {
      logger.warn('Return event warning', { eventId: evt.eventId, contractId: evt.contractId, warning, service: SERVICE });
    }
    logger.info('Return applied', {
      eventId: evt.eventId, contractId: line.contractId, dataAreaId: line.dataAreaId, returnWarehouseId: line.returnWarehouseId, service: SERVICE,
    });
    incrementMetric('rentalsync.return.applied', { route: `${ROUTE_BASE}/returns`, dataAreaId: line.dataAreaId });
    recordTiming('rentalsync.return.latency', Date.now() - startTime, { route: `${ROUTE_BASE}/returns` });
    return { eventId: evt.eventId, status: 'Applied', contractLine: line, deadLetter: null, warnings: mapped.warnings };
  } catch (error) {
    if (!(error instanceof ReturnMappingError)) throw error;
    const deadLetter = parkDeadLetter(evt, error);
    logger.error('Return dead-lettered', {
      eventId: evt.eventId, dealerCode: evt.dealerCode, contractId: evt.contractId, errorCode: error.errorCode, reason: error.message, deliveryCount: deadLetter.deliveryCount, service: SERVICE,
    });
    incrementMetric('rentalsync.return.deadlettered', { route: `${ROUTE_BASE}/returns`, errorCode: error.errorCode });
    if (report) {
      Sentry.captureException(error, {
        tags: { route: `${ROUTE_BASE}/returns`, service: SERVICE, errorCode: error.errorCode },
        extra: { eventId: evt.eventId, dealerCode: evt.dealerCode, contractId: evt.contractId, returnYard: evt.returnYard, deliveryCount: deadLetter.deliveryCount },
      });
    }
    return { eventId: evt.eventId, status: 'DeadLettered', contractLine: null, deadLetter, warnings: [] };
  }
}

async function replayDeadLetter(eventId) {
  const deadLetter = deadLetters.get(eventId);
  if (!deadLetter) return null;
  logger.info('Replaying dead letter', { eventId, delivery: deadLetter.deliveryCount + 1, service: SERVICE });
  incrementMetric('rentalsync.deadletter.replay', { route: `${ROUTE_BASE}/deadletters/replay` });
  const result = await processReturnEvent(deadLetter.body);
  if (result.status === 'Applied') deadLetters.delete(eventId);
  return result;
}

function listDeadLetters() {
  return [...deadLetters.values()].sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt));
}

/** Validate the wire shape of an inbound return event; returns a clean event or throws ValidationError. */
function validateReturnEvent(body) {
  const b = body || {};
  const errors = [];
  const str = (k) => (typeof b[k] === 'string' && b[k].trim() ? b[k].trim() : null);
  const eventId = str('eventId');
  const dealerCode = str('dealerCode');
  const contractId = str('contractId');
  const serialNumber = str('serialNumber');
  const returnYard = str('returnYard');
  const hoursMeter = Number(b.hoursMeter);
  const fuelPercent = Number(b.fuelPercent);
  const returnedAt = typeof b.returnedAt === 'string' && !Number.isNaN(Date.parse(b.returnedAt)) ? new Date(b.returnedAt).toISOString() : null;
  if (!eventId) errors.push('eventId is required.');
  if (!dealerCode) errors.push('dealerCode is required.');
  if (!contractId) errors.push('contractId is required.');
  if (!serialNumber) errors.push('serialNumber is required.');
  if (!returnYard) errors.push('returnYard is required.');
  if (!Number.isInteger(hoursMeter) || hoursMeter < 0) errors.push('hoursMeter must be a non-negative integer.');
  if (!Number.isInteger(fuelPercent)) errors.push('fuelPercent must be an integer.');
  if (!returnedAt) errors.push('returnedAt must be an ISO-8601 timestamp.');
  if (errors.length) throw new ValidationError('Return event failed validation.', errors);
  return {
    eventId, dealerCode, contractId, serialNumber, returnYard, hoursMeter, fuelPercent, returnedAt,
    source: str('source') || 'catrentals',
  };
}

// ---- alert → Devin webhook ----------------------------------------------------------------------

/** Trimmed Azure Monitor common alert schema for the dead-letter metric rule. */
function buildAlertPayload({ firedAt = new Date().toISOString(), pageUrl = '' } = {}) {
  const items = listDeadLetters();
  const alertId = uuidv4();
  return {
    schemaId: 'azureMonitorCommonAlertSchema',
    data: {
      essentials: {
        alertId: `/subscriptions/4f1c0c7e-demo/providers/Microsoft.AlertsManagement/alerts/${alertId}`,
        alertRule: ALERT_RULE,
        severity: 'Sev2',
        signalType: 'Metric',
        monitorCondition: items.length > 0 ? 'Fired' : 'Resolved',
        monitoringService: 'Platform',
        alertTargetIDs: ['/subscriptions/4f1c0c7e-demo/resourcegroups/rg-converge-integration-prod/providers/microsoft.servicebus/namespaces/sb-converge-prod'],
        configurationItems: ['sb-converge-prod/catrentals-returns/converge-rentalsync/$DeadLetterQueue'],
        originAlertId: alertId,
        firedDateTime: firedAt,
        description: `Dead-lettered messages on catrentals-returns/converge-rentalsync exceeded threshold (${items.length} > 0) for 15 minutes. Returned machines are still OnRent in Cat Converge (F&O).`,
        essentialsVersion: '1.0',
        alertContextVersion: '1.0',
      },
      alertContext: {
        conditionType: 'SingleResourceMultipleMetricCriteria',
        condition: {
          windowSize: 'PT15M',
          allOf: [{
            metricName: 'DeadletteredMessages',
            metricNamespace: 'Microsoft.ServiceBus/namespaces',
            operator: 'GreaterThan',
            threshold: '0',
            timeAggregation: 'Maximum',
            dimensions: [{ name: 'EntityName', value: 'catrentals-returns' }],
            metricValue: items.length,
          }],
        },
      },
      customProperties: {
        service: 'converge-rentalsync',
        repo: 'COG-GTM/event-driven-devin',
        servicePath: 'app/services/verticals/b6e7eac1.js',
        runbook: 'docs/b6e7eac1/runbook-deadletters.md',
        opsConsole: pageUrl,
        deadLetters: items.map((d) => d.eventId),
        deadLetterSummary: items.map((d) => ({
          eventId: d.eventId, dealerCode: d.body.dealerCode, contractId: d.body.contractId, errorCode: d.errorCode, deliveryCount: d.deliveryCount,
        })),
        simulated: 'Azure Monitor, Azure Service Bus and Dynamics 365 F&O are simulated by the demo service. The Devin session, Teams posts, PR and CI are real.',
      },
    },
  };
}

class DeadLetterAlert extends Error {
  constructor(message) {
    super(message);
    this.name = 'DeadLetterAlert';
  }
}

const RUNBOOK_APPENDIX = 'This is the Sev2 dead-letter alert for the rental-return integration (slug b6e7eac1). '
  + 'Follow docs/b6e7eac1/runbook-deadletters.md and docs/b6e7eac1/STEERABILITY.md. Run `npx jest tests/b6e7eac1-deadletter-triage.test.js tests/b6e7eac1-catsec-gate.test.js`, '
  + 'start the service with `PORT=5000 DD_TRACE_ENABLED=false node app/server.js` (boot re-parks the same dead letters), read GET /api/b6e7eac1/deadletters (errorCode, reason, full body) and GET /api/b6e7eac1/contracts/{dataAreaId}. '
  + 'For each dead letter post one plain-language reply in the alert thread: dealer and contract, root cause in one sentence, the fix, and the owner (this team, Cat Rentals, dealer, or D365 configuration). '
  + 'Fix only what this team owns, minimally, in app/services/verticals/b6e7eac1-seed.js (or resolveDealer in b6e7eac1.js for dealer aliases), with one regression test per fix in tests/b6e7eac1-*.test.js. '
  + 'Flag data-quality problems in the inbound event (e.g. fuelPercent above 100) to Cat Rentals; do not change the mapper clamp (KI-07 in docs/b6e7eac1/KNOWN_ISSUES.md). '
  + 'Restart the service on your branch and POST /api/b6e7eac1/deadletters/{eventId}/replay for each event; report per event whether it applied (200, line now Returned) or is still parked (409, with the new reason). '
  + 'Open one PR; never merge. Never say Azure Monitor, Service Bus or D365 are live — they are simulated in this environment. Never include machine serial numbers in posts or the PR.';

/**
 * Fire the dead-letter alert. Only ever called from the presenter's click on
 * POST /api/b6e7eac1/alerts/fire — never from a timer. Posts the Slack alert and
 * starts the Devin session through createSessionAndAlert like every other demo.
 */
async function fireAlert({ pageUrl = '', devinUserId = '', devinOrgId = '', devinEmail = '' } = {}) {
  const requestId = uuidv4();
  const startTime = Date.now();
  const payload = buildAlertPayload({ pageUrl });
  const items = listDeadLetters();

  if (items.length === 0) {
    return { success: false, sent: false, requestId, message: 'Dead-letter queue is empty; nothing to alert on. Reset the demo data first.', payload };
  }
  if (alertInFlight) {
    return { success: false, sent: false, requestId, message: 'An alert is already being sent; wait for it to finish.', payload };
  }

  alertInFlight = true;
  const summary = items.map((d) => `${d.eventId} (${d.body.dealerCode} ${d.body.contractId}: ${d.errorCode})`).join(', ');
  const error = new DeadLetterAlert(`${ALERT_RULE}: ${items.length} dead-lettered return events on catrentals-returns/converge-rentalsync — ${summary}`);
  logger.error('Dead-letter alert fired', { requestId, rule: ALERT_RULE, deadLetters: items.map((d) => d.eventId), requester: devinEmail || devinUserId || 'anonymous', service: SERVICE });
  Sentry.captureException(error, {
    tags: { route: FIRE_ROUTE, service: SERVICE, rule: ALERT_RULE, severity: 'Sev2' },
    extra: { requestId, deadLetters: payload.data.customProperties.deadLetterSummary },
  });

  try {
    const result = await createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/b6e7eac1.js — processReturnEvent',
      errorType: error.name,
      errorValue: error.message,
      devinUserId,
      devinEmail,
      devinOrgId,
      service: SERVICE,
      verticalLabel: 'Cat Converge — Rental-return integration (Service Bus dead-letter alert)',
      slackMemberId: SLACK_MEMBER_ID,
      tags: [
        { key: 'route', value: FIRE_ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'alertRule', value: ALERT_RULE },
        { key: 'severity', value: 'Sev2' },
      ],
      extra: {
        requestId,
        alertRule: ALERT_RULE,
        severity: 'Sev2',
        monitorCondition: 'Fired',
        deadLetters: payload.data.customProperties.deadLetterSummary,
        opsConsole: pageUrl,
        promptContext: payload.data.essentials.description,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'b6e7eac1@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: ALERT_RULE,
      promptAppendix: RUNBOOK_APPENDIX,
    });
    recordTiming('rentalsync.alert.latency', Date.now() - startTime, { route: FIRE_ROUTE });
    incrementMetric('rentalsync.alert.sent', { route: FIRE_ROUTE });
    const sessionUrl = result && result.session && result.session.url ? result.session.url : null;
    lastAlert = { requestId, firedAt: payload.data.essentials.firedDateTime, sent: true, sessionUrl };
    return { success: true, sent: true, requestId, message: 'Alert posted to Slack; Devin session starting.', sessionUrl, payload };
  } catch (err) {
    incrementMetric('rentalsync.alert.failure', { route: FIRE_ROUTE, errorClass: err.name });
    logger.error('Failed to trigger Devin session from dead-letter alert', { requestId, error: err.message, service: SERVICE });
    return { success: false, sent: false, requestId, message: `Alert could not be delivered: ${err.message}`, payload };
  } finally {
    alertInFlight = false;
  }
}

// ---- reset / state ------------------------------------------------------------------------------

async function resetDemo() {
  const cleared = deadLetters.size;
  contractLines.clear();
  deadLetters.clear();
  for (const line of seed.CONTRACT_LINES) {
    contractLines.set(lineKey(line.dataAreaId, line.contractId), { ...line });
  }
  const parked = [];
  for (const evt of seed.STUCK_RETURN_EVENTS) {
    const result = await processReturnEvent(evt, { report: false });
    if (result.status === 'DeadLettered') parked.push(evt.eventId);
  }
  lastResetAt = new Date().toISOString();
  lastAlert = null;
  logger.info('Demo state reset', { cleared, contractLines: contractLines.size, deadLetters: parked.length, service: SERVICE });
  incrementMetric('rentalsync.reset', { route: `${ROUTE_BASE}/alerts/reset` });
  return { success: true, cleared, contractLines: contractLines.size, deadLetters: parked, resetAt: lastResetAt };
}

function getState() {
  const items = listDeadLetters();
  return {
    rule: ALERT_RULE,
    severity: 'Sev2',
    condition: items.length > 0 ? 'Fired' : 'Resolved',
    deadLetterCount: items.length,
    deadLetters: items,
    dealers: [...seed.DEALERS].sort((a, b) => a.dataAreaId.localeCompare(b.dataAreaId)),
    contracts: seed.DEALERS.map((d) => d.dataAreaId).sort().flatMap((id) => listContractLines(id)),
    alertDestination: 'slack',
    lastResetAt,
    lastAlert,
    alertPreview: buildAlertPayload(),
  };
}

const ready = resetDemo();

module.exports = {
  SERVICE,
  ALERT_RULE,
  ERROR_CODES,
  ReturnMappingError,
  ValidationError,
  ready,
  validateReturnEvent,
  mapReturnEvent,
  processReturnEvent,
  replayDeadLetter,
  listDeadLetters,
  listContractLines,
  getContractLine,
  buildAlertPayload,
  fireAlert,
  resetDemo,
  getState,
};
