const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { lookupStop, assessEligibility, formatClaim } = require('./188f0cf2-dispatch');

const service = '188f0cf2-api';
const route = '/api/188f0cf2/claims';
const HISTORY = [];
const ACCOUNT = { addressId: 'ADDR-1048', address: '1048 Harbor Lane', city: 'Brookfield, IL 60513', account: 'BP-204819', name: 'Alex Morgan' };
const SCHEDULE = [
  { container: 'Trash', next: 'Tuesday, Nov 24', cadence: 'Every Tuesday', size: '96-gallon cart' },
  { container: 'Recycling', next: 'Tuesday, Dec 1', cadence: 'Every other Tuesday', size: '64-gallon cart' },
  { container: 'Yard waste', next: 'Monday, Nov 23', cadence: 'Every Monday · seasonal', size: 'Paper bags or bundled branches' },
];
const PICKUPS = [
  { date: '2026-11-17', container: 'Recycling', status: 'Service exception' },
  { date: '2026-11-17', container: 'Trash', status: 'Collected' },
  { date: '2026-11-16', container: 'Yard waste', status: 'Collected' },
];
function overview() {
  return { account: ACCOUNT, schedule: SCHEDULE, pickups: PICKUPS, claims: HISTORY, failed: HISTORY.some(item => item.status === 'failed') };
}
function resetClaims() {
  const cleared = HISTORY.length;
  HISTORY.length = 0;
  logger.info('Claims reset', { service, cleared });
  incrementMetric('188f0cf2.reset', { route: `${route}/reset` });
  return { success: true, cleared, status: 'ready' };
}
async function processClaim(data) {
  const requestId = uuidv4();
  const started = Date.now();
  const stop = await lookupStop(ACCOUNT.addressId, data.date, data.container);
  if (!stop) {
    const error = new Error('No scheduled pickup found for this container and date.');
    error.statusCode = 422;
    throw error;
  }
  logger.info('Reviewing pickup claim', { service, requestId, stopId: stop.id });
  try {
    await new Promise(resolve => setTimeout(resolve, 70 + Math.random() * 110));
    const result = formatClaim(requestId, assessEligibility(stop));
    HISTORY.push({ requestId, status: 'submitted' });
    incrementMetric('188f0cf2.claim.success', { route });
    return { success: true, ...result };
  } catch (error) {
    HISTORY.push({ requestId, status: 'failed' });
    incrementMetric('188f0cf2.claim.failure', { route, errorClass: error.name });
    logger.error('Pickup claim failed', { service, requestId, error: error.message });
    Sentry.captureException(error, { tags: { service, route, alert_path: 'instant' }, extra: { requestId, stopId: stop.id } });
    logger.info('Invoking createSessionAndAlert', { service, route, requestId });
    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?query=is%3Aunresolved`,
      culprit: 'app/services/verticals/188f0cf2.js — processClaim',
      errorType: error.name, errorValue: error.message,
      devinUserId: data.devinUserId, devinOrgId: data.devinOrgId, devinEmail: data.devinEmail,
      service, verticalLabel: 'Missed pickup claims', skipVulnerablePr: true,
      tags: [{ key: 'route', value: route }, { key: 'service', value: service }, { key: 'page', value: '/188f0cf2' }],
      extra: { requestId, stopId: stop.id, source: stop.source, routeId: stop.route },
      promptAppendix: 'Investigate the pickup claim failure at /188f0cf2. Trace dispatch stop data from the driver route app through eligibility and service-credit handling. Preserve raw dispatch evidence. A stop with incomplete evidence must enter manual review, not be automatically denied or awarded credit. Cover completed, exception, missing-reason, and unknown-reason records across the dispatch adapter, assessment, and response formatting. Open a pull request with a plain-English root-cause analysis and regression tests; do not merge.',
      level: 'error', platform: 'node', firstSeen: '', lastSeen: new Date().toISOString(), count: '', shortId: '',
      project: 'event-driven-devin', release: process.env.SENTRY_RELEASE || '188f0cf2@1.0.0', environment: process.env.DD_ENV || 'prod', triggeredRule: '',
    }).catch(err => logger.error('Failed to trigger Devin session', { service, error: err.message }));
    throw error;
  } finally {
    recordTiming('188f0cf2.claim.latency', Date.now() - started, { route });
  }
}
module.exports = { overview, resetClaims, processClaim };
