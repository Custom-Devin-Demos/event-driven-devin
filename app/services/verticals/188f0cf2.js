const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { lookupStop, assessEligibility, formatClaim } = require('./188f0cf2-dispatch');

const service = '188f0cf2-api';
const route = '/api/188f0cf2/claims';
const HISTORY = [];
let alerted = false;
const ACCOUNT = { name: 'Northfield Health', contact: 'Dana Ruiz', title: 'Director of Facilities', account: 'BPE-30417', sites: 42, contract: 'Enterprise service agreement · renews Jun 2027', guarantee: 'Missed pickups recovered within 24 hours or credited' };
const KPIS = [
  { label: 'Active sites', value: '42', note: 'IL · WI · IN' },
  { label: 'On-time service (30 days)', value: '98.7%', note: 'Contract target 99.0%' },
  { label: 'Open service issues', value: '3', note: '1 hospital loading dock' },
  { label: 'Pickups this month', value: '2,318', note: 'Front-load, roll-off, recycling' },
];
const SITES = [
  { id: 'NH-001', name: 'Northfield Medical Center', area: 'Main campus · Evanston, IL', service: 'Front-load 8 yd', next: 'Daily · 5:00 AM', status: 'Missed service' },
  { id: 'NH-002', name: 'Lakeview Surgical Pavilion', area: 'Chicago, IL', service: 'Compactor 30 yd', next: 'Thu, Nov 19', status: 'On schedule' },
  { id: 'NH-004', name: 'Northfield Children\u2019s Hospital', area: 'Skokie, IL', service: 'Front-load 8 yd', next: 'Daily · 5:30 AM', status: 'On schedule' },
  { id: 'NH-011', name: 'Kenosha Outpatient Center', area: 'Kenosha, WI', service: 'Recycling 6 yd', next: 'Wed, Nov 18', status: 'On schedule' },
  { id: 'NH-019', name: 'Gary Regional Clinic', area: 'Gary, IN', service: 'Front-load 8 yd', next: 'Wed, Nov 18', status: 'On schedule' },
];
function overview() {
  return { account: ACCOUNT, kpis: KPIS, sites: SITES, claims: HISTORY, failed: HISTORY.some(item => item.status === 'failed') };
}
function resetClaims() {
  const cleared = HISTORY.length;
  HISTORY.length = 0;
  alerted = false;
  logger.info('Claims reset', { service, cleared });
  incrementMetric('188f0cf2.reset', { route: `${route}/reset` });
  return { success: true, cleared, status: 'ready' };
}
async function processClaim(data) {
  const requestId = uuidv4();
  const started = Date.now();
  const stop = await lookupStop(data.siteId, data.date, data.service);
  if (!stop) {
    const error = new Error('No scheduled service found for this site, service and date.');
    error.statusCode = 422;
    throw error;
  }
  logger.info('Reviewing missed service report', { service, requestId, stopId: stop.id });
  try {
    await new Promise(resolve => setTimeout(resolve, 70 + Math.random() * 110));
    const result = formatClaim(requestId, assessEligibility(stop));
    HISTORY.push({ requestId, status: 'submitted' });
    incrementMetric('188f0cf2.claim.success', { route });
    return { success: true, ...result };
  } catch (error) {
    HISTORY.push({ requestId, status: 'failed' });
    incrementMetric('188f0cf2.claim.failure', { route, errorClass: error.name });
    logger.error('Missed service report failed', { service, requestId, error: error.message });
    Sentry.captureException(error, { tags: { service, route, alert_path: 'instant' }, extra: { requestId, stopId: stop.id } });
    if (alerted) throw error;
    alerted = true;
    logger.info('Invoking createSessionAndAlert', { service, route, requestId });
    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?query=is%3Aunresolved`,
      culprit: 'app/services/verticals/188f0cf2.js — processClaim',
      errorType: error.name, errorValue: error.message,
      devinUserId: data.devinUserId, devinOrgId: data.devinOrgId, devinEmail: data.devinEmail,
      service, verticalLabel: 'Enterprise missed service reports', skipVulnerablePr: true,
      tags: [{ key: 'route', value: route }, { key: 'service', value: service }, { key: 'page', value: '/188f0cf2' }],
      extra: { requestId, siteId: data.siteId, stopId: stop.id, source: stop.source, routeId: stop.route },
      promptAppendix: 'Investigate the enterprise missed-service report failure at /188f0cf2. Trace dispatch stop data from the driver route app through eligibility and contract service-credit handling, and size the blast radius (which reports and sites are affected). Preserve raw dispatch evidence. A stop with incomplete evidence must enter manual review, not be automatically denied or awarded credit. Cover completed, exception, missing-reason, and unknown-reason records across the dispatch adapter, assessment, and response formatting. Open a pull request with a plain-English root-cause analysis and regression tests; do not merge.',
      level: 'error', platform: 'node', firstSeen: '', lastSeen: new Date().toISOString(), count: '', shortId: '',
      project: 'event-driven-devin', release: process.env.SENTRY_RELEASE || '188f0cf2@1.0.0', environment: process.env.DD_ENV || 'prod', triggeredRule: '',
    }).catch(err => logger.error('Failed to trigger Devin session', { service, error: err.message }));
    throw error;
  } finally {
    recordTiming('188f0cf2.claim.latency', Date.now() - started, { route });
  }
}
module.exports = { overview, resetClaims, processClaim };
