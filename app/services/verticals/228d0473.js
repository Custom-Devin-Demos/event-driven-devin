const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { buildSchedule } = require('./228d0473-schedule');

const CUSTOMER = '228d0473';
const ROUTE = '/api/228d0473/enquiries';
const SERVICE = 'masterpiece-enquiry-service';
const LABEL = 'Chubb SG — Masterpiece Home & Contents Enquiry';

// Server-side owner for alerts and Devin sessions. Browser-supplied identity
// is recorded as diagnostic context only and never changes ownership.
const OWNER = Object.freeze({
  slackMemberId: 'U08S7AVJ478',
  devinUserId: 'clerk-user_2eG9PmvFhmV7fNu7TNuSRGeGPpV',
  devinOrgId: 'org-3d7ae9a506414a189c9a81472e85b5b9',
});

// Indicative profile used to pre-fill the specialist call-back for a
// Masterpiece enquiry from the home & contents page.
const DEFAULT_PROFILE = Object.freeze({
  propertyType: 'landed',
  buildingsSumInsured: 2500000,
  contentsSumInsured: 600000,
  valuables: [
    { category: 'jewellery', value: 120000 },
    { category: 'fine_art', value: 250000 },
    { category: 'wine_spirits', value: 40000 },
    { category: 'handbags', value: 18000 },
  ],
});

function enquiryReference() {
  return `MP-SG-${uuidv4().slice(0, 8).toUpperCase()}`;
}

function buildEnquiry(profile, entryPoint) {
  const schedule = buildSchedule(profile);
  return {
    reference: enquiryReference(),
    product: 'masterpiece-home',
    entryPoint,
    schedule,
    underinsuredCategories: schedule.lines.filter((l) => l.underinsured).map((l) => l.category),
    createdAt: new Date().toISOString(),
  };
}

/**
 * Submit a Masterpiece specialist enquiry from any call to action on the page.
 *
 * @param {object} data - { entryPoint, market, report, devinUserId, devinOrgId, devinEmail }
 */
async function submitEnquiry(data) {
  const requestId = uuidv4();
  const startTime = Date.now();
  const entryPoint = String(data.entryPoint || 'unknown').slice(0, 80);
  const market = String(data.market || 'SG').slice(0, 4);
  const reportFailures = data.report !== false;
  const profile = DEFAULT_PROFILE;

  incrementMetric('masterpiece_enquiry.started', { route: ROUTE, service: SERVICE, market, entry_point: entryPoint });
  logger.info('Masterpiece enquiry started', { requestId, entryPoint, market, service: SERVICE });

  try {
    const enquiry = buildEnquiry(profile, entryPoint);
    const duration = Date.now() - startTime;
    incrementMetric('masterpiece_enquiry.success', { route: ROUTE, service: SERVICE, market });
    recordTiming('masterpiece_enquiry.latency', duration, { route: ROUTE });
    logger.info('Masterpiece enquiry created', { requestId, reference: enquiry.reference, durationMs: duration });
    return { requestId, ...enquiry };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('masterpiece_enquiry.failure', { route: ROUTE, service: SERVICE, market, errorClass: error.name });
    recordTiming('masterpiece_enquiry.latency', duration, { route: ROUTE, error: 'true' });
    logger.error('Masterpiece enquiry failed', {
      requestId, entryPoint, market, error: error.message, errorClass: error.name, durationMs: duration, service: SERVICE,
    });
    error.requestId = requestId;
    if (!error.statusCode) error.statusCode = 500;

    if (!reportFailures) {
      logger.info('Masterpiece enquiry failure reporting disabled for this request', { requestId });
      throw error;
    }

    const context = {
      requestId,
      entryPoint,
      market,
      propertyType: profile.propertyType,
      valuables: profile.valuables.map((v) => v.category),
      requestIdentity: { devinUserId: data.devinUserId || '', devinOrgId: data.devinOrgId || '', devinEmail: data.devinEmail || '' },
    };

    Sentry.captureException(error, {
      tags: {
        route: ROUTE, service: SERVICE, customer: CUSTOMER, market, alert_path: 'instant',
      },
      transaction: `POST ${ROUTE}`,
      extra: context,
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/228d0473.js — submitEnquiry',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: OWNER.devinUserId,
      devinOrgId: OWNER.devinOrgId,
      customer: CUSTOMER,
      slackMemberId: OWNER.slackMemberId,
      slackMemberIdFallback: OWNER.slackMemberId,
      service: SERVICE,
      verticalLabel: LABEL,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'market', value: market },
        { key: 'entry_point', value: entryPoint },
      ],
      extra: {
        ...context,
        promptContext: 'Every call to action on the Chubb Singapore Home & Contents page (Contact us about Masterpiece, Get a Quote, Contact Me, navigation and footer links) submits a Masterpiece specialist enquiry, and every enquiry fails with HTTP 500 before a schedule of cover is produced, so no prospect can request a call-back.',
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@2.4.0`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
      promptAppendix: 'Reproduce locally with "report": false in the request body (or /228d0473?reports=off) so no new alerts fire. When you fix this, add a regression test that builds a schedule for every category in the catalogue, and record a browser video of /228d0473 showing an enquiry succeeding.',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session', { error: err.message, requestId });
    });

    throw error;
  }
}

module.exports = { submitEnquiry, buildEnquiry, DEFAULT_PROFILE, OWNER };
