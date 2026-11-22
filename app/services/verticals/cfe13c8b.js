const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { runWithAlertDestination } = require('../alert-destination');
const { BRANCHES, WORK_ORDER, readAvailability } = require('./cfe13c8b-inventory');

const SERVICE = 'cfe13c8b-api';
const ROUTE = '/api/cfe13c8b/availability';
let alertAttempted = false;
let dispatching = false;

function getWorkOrder() {
  return {
    workOrder: WORK_ORDER,
    branches: BRANCHES.map(({ id, name, city }) => ({ id, name, city })),
  };
}

function resetAvailability({ reports = false } = {}) {
  if (reports && dispatching) return null;
  if (reports) alertAttempted = false;
  return getWorkOrder();
}

function reportFailure(error, context, presenter) {
  if (alertAttempted || dispatching) return;
  alertAttempted = true;
  dispatching = true;

  Sentry.captureException(error, { tags: { service: SERVICE, alert_path: 'instant', route: ROUTE }, extra: context });
  runWithAlertDestination('teams', () => createSessionAndAlert({
    issueTitle: 'Dealer parts lookup failed',
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/`,
    culprit: 'app/services/verticals/cfe13c8b-inventory.js — readAvailability',
    errorType: error.name,
    errorValue: `${error.message}\nBranch: ${context.branchId} · Part: ${context.partNumber} · Work order: ${context.workOrder}\nFeed batch: ${context.feedBatch} (v${context.feedVersion}) · Request: ${context.requestId}`,
    customer: 'cfe13c8b',
    ...presenter,
    service: SERVICE,
    verticalLabel: 'Dealer Parts Availability',
    skipVulnerablePr: true,
    promptAppendix: 'Investigate the synthetic parts availability incident in COG-GTM/event-driven-devin. Compare the affected branch with a healthy branch, report the impact and root cause in the alert thread, and open a reviewable fix PR with regression coverage for both feeds. Verify at /cfe13c8b without reports=on or via a local POST /api/cfe13c8b/availability with the same branch and part. Do not merge or deploy.',
    tags: [{ key: 'service', value: SERVICE }, { key: 'route', value: ROUTE }],
    extra: context,
    level: 'error',
    platform: 'node',
    lastSeen: new Date().toISOString(),
    project: 'event-driven-devin',
    release: process.env.SENTRY_RELEASE || 'cfe13c8b@1.0.0',
    environment: process.env.DD_ENV || 'prod',
  })).catch(err => logger.error('Parts availability alert dispatch failed', { service: SERVICE, error: err.message }))
    .finally(() => { dispatching = false; });
}

function checkAvailability({ branchId, partNumber, reports = false, presenter = {} } = {}) {
  const branch = BRANCHES.find(item => item.id === branchId);
  if (!branch || partNumber !== WORK_ORDER.part.number) {
    return { status: 400, body: { message: 'Select a branch and enter the part number on this work order.' } };
  }

  const requestId = uuidv4();
  const started = Date.now();
  const context = {
    requestId, branchId, partNumber, workOrder: WORK_ORDER.id, feedBatch: branch.feedBatch, feedVersion: branch.feedVersion,
  };

  try {
    const availability = readAvailability(branchId, partNumber);
    logger.info('Dealer parts availability checked', { service: SERVICE, ...context });
    incrementMetric('cfe13c8b.availability.success', { service: SERVICE, branch: branchId });
    return { status: 200, body: { requestId, ...availability } };
  } catch (error) {
    logger.error('Dealer parts availability failed', { service: SERVICE, ...context, error: error.message, stack: error.stack });
    incrementMetric('cfe13c8b.availability.failure', { service: SERVICE, branch: branchId });
    if (reports) reportFailure(error, context, presenter);
    return {
      status: 503,
      body: { requestId, code: 'INVENTORY_UNAVAILABLE', message: 'We couldn’t check stock at this branch.' },
    };
  } finally {
    recordTiming('cfe13c8b.availability.latency', Date.now() - started, { service: SERVICE });
  }
}

module.exports = { getWorkOrder, checkAvailability, resetAvailability };
