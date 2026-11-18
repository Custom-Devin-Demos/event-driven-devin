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
  { label: 'Collected this month', value: '1,284 t', note: '2,318 pickups', icon: 'scale', meter: 64 },
  { label: 'Diversion rate', value: '38%', note: 'Goal 40% recycled or composted', icon: 'recycle', meter: 95 },
  { label: 'On-time service (30 days)', value: '98.7%', note: 'Contract target 99.0%', icon: 'clock', meter: 98.7 },
  { label: 'Open service issues', value: '3', note: '1 hospital loading dock', icon: 'alert', meter: 0 },
];
const TODAY = { serviced: 37, scheduled: 42, tons: '61.4 t', trucks: 5, missed: 1, routes: 'C-118 · C-121 · C-140 · C-152 · RO-07' };
const SITES = [
  { id: 'NH-001', name: 'Northfield Medical Center', area: 'Main campus · Evanston, IL', service: 'Front-load 8 yd', route: 'C-118', last: 'Missed · 5:00 AM', tons: 46.2, status: 'Missed pickup' },
  { id: 'NH-002', name: 'Lakeview Surgical Pavilion', area: 'Chicago, IL', service: 'Compactor 30 yd', route: 'RO-07', last: 'Yesterday · 2:40 PM', tons: 31.8, fill: 82, status: 'Haul scheduled' },
  { id: 'NH-004', name: 'Northfield Children\u2019s Hospital', area: 'Skokie, IL', service: 'Front-load 8 yd', route: 'C-121', last: 'Today · 5:34 AM', tons: 28.4, status: 'Serviced' },
  { id: 'NH-011', name: 'Kenosha Outpatient Center', area: 'Kenosha, WI', service: 'Recycling 6 yd', route: 'C-140', last: 'Mon · 7:12 AM', tons: 9.6, status: 'On schedule' },
  { id: 'NH-019', name: 'Gary Regional Clinic', area: 'Gary, IN', service: 'Front-load 8 yd', route: 'C-152', last: 'Mon · 6:05 AM', tons: 12.1, status: 'On schedule' },
];
const PICKUPS = [
  { time: '5:00 AM', route: 'C-118', site: 'Northfield Medical Center', detail: 'Front-load 8 yd · loading dock', state: 'missed', note: 'Not serviced' },
  { time: '5:34 AM', route: 'C-121', site: 'Northfield Children\u2019s Hospital', detail: 'Front-load 8 yd', state: 'done', note: '2.1 t' },
  { time: '6:10 AM', route: 'C-118', site: 'Northfield Medical Center', detail: 'Recycling 6 yd', state: 'done', note: '0.6 t' },
  { time: '9:30 AM', route: 'RO-07', site: 'Lakeview Surgical Pavilion', detail: 'Compactor haul · 82% full', state: 'next', note: 'Scheduled' },
];
const STREAMS = [
  { label: 'Landfill', tons: 796, share: 62 },
  { label: 'Single-stream recycling', tons: 347, share: 27 },
  { label: 'Cardboard (OCC)', tons: 141, share: 11 },
];
function overview() {
  return { account: ACCOUNT, kpis: KPIS, today: TODAY, sites: SITES, pickups: PICKUPS, streams: STREAMS, claims: HISTORY, failed: HISTORY.some(item => item.status === 'failed') };
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
    Sentry.captureException(error, { tags: { service, route, alert_path: 'instant' }, extra: { requestId, stopId: stop.id, notes: data.notes || '' } });
    if (alerted) throw error;
    alerted = true;
    logger.info('Invoking createSessionAndAlert', { service, route, requestId });
    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?query=is%3Aunresolved`,
      culprit: 'app/services/verticals/188f0cf2.js — processClaim',
      errorType: error.name, errorValue: error.message,
      devinUserId: data.devinUserId, devinOrgId: data.devinOrgId, devinEmail: data.devinEmail,
      service, verticalLabel: 'Enterprise missed service reports', skipVulnerablePr: true, slackMemberId: process.env.ONCALL_SLACK_MEMBER_ID_188F0CF2 || 'U0BDHHQUM24',
      tags: [{ key: 'route', value: route }, { key: 'service', value: service }, { key: 'page', value: '/188f0cf2' }],
      extra: { requestId, siteId: data.siteId, notes: data.notes || '', stopId: stop.id, source: stop.source, routeId: stop.route },
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
