const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { resolveOffering } = require('./549ee872-catalog');
const { estimateCosts, buildDisclosures } = require('./549ee872-pricing');

const CUSTOMER = '549ee872';
const ROUTE = '/api/549ee872/applications';
const SERVICE = 'homepage-account-opening';

// Server-side owner for alerts and Devin sessions. Browser-supplied identity
// is recorded as diagnostic context only and never changes ownership.
const OWNER = Object.freeze({
  slackMemberId: 'U08S7AVJ478',
  devinUserId: 'clerk-user_2eG9PmvFhmV7fNu7TNuSRGeGPpV',
  devinOrgId: 'org-7e0b81b229324c7fb1dbb1856fd67ff0',
});

const DEFAULT_FUNDING = Object.freeze({ initialDeposit: 2500, method: 'eft', registration: 'individual' });

function normalizeFunding(input, offering) {
  const src = input && typeof input === 'object' ? input : {};
  const deposit = Number.parseFloat(src.initialDeposit);
  const method = typeof src.method === 'string' && offering.fundingMethods.includes(src.method) ? src.method : offering.fundingMethods[0];
  const registration = typeof src.registration === 'string' && offering.registrations.includes(src.registration)
    ? src.registration : offering.registrations[0];
  return {
    initialDeposit: Number.isFinite(deposit) && deposit >= 0 ? deposit : DEFAULT_FUNDING.initialDeposit,
    method,
    registration,
  };
}

function buildApplication(offering, funding, entryPoint) {
  const costs = estimateCosts(offering, funding);
  const disclosures = buildDisclosures(offering);
  return {
    applicationId: `FA-${uuidv4().slice(0, 8).toUpperCase()}`,
    offering: offering.code,
    offeringName: offering.name,
    family: offering.family,
    registration: funding.registration,
    fundingMethod: funding.method,
    costs,
    disclosures,
    nextStep: offering.productPath,
    entryPoint,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Start an account application from any homepage entry point.
 *
 * @param {object} data - { selection, entryPoint, funding, report, devinUserId, devinOrgId, devinEmail }
 */
async function startApplication(data) {
  const requestId = uuidv4();
  const startTime = Date.now();
  const entryPoint = String(data.entryPoint || 'unknown').slice(0, 80);
  const offering = resolveOffering(data.selection, entryPoint);
  const funding = normalizeFunding(data.funding, offering);
  const reportFailures = data.report !== false;

  incrementMetric('homepage_application.started', { route: ROUTE, service: SERVICE, offering: offering.code, entry_point: entryPoint });
  logger.info('Homepage application started', { requestId, offering: offering.code, entryPoint, registration: funding.registration, service: SERVICE });

  try {
    const application = buildApplication(offering, funding, entryPoint);
    const duration = Date.now() - startTime;
    incrementMetric('homepage_application.success', { route: ROUTE, service: SERVICE, offering: offering.code });
    recordTiming('homepage_application.latency', duration, { route: ROUTE });
    logger.info('Homepage application created', { requestId, applicationId: application.applicationId, offering: offering.code, durationMs: duration });
    return { requestId, ...application };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('homepage_application.failure', { route: ROUTE, service: SERVICE, offering: offering.code, errorClass: error.name });
    recordTiming('homepage_application.latency', duration, { route: ROUTE, error: 'true' });
    logger.error('Homepage application failed', {
      requestId, offering: offering.code, feeSchedule: offering.feeSchedule, entryPoint, error: error.message, errorClass: error.name, durationMs: duration, service: SERVICE,
    });

    error.requestId = requestId;
    if (!error.statusCode) error.statusCode = 500;

    if (!reportFailures) {
      logger.info('Homepage application failure reporting disabled for this request', { requestId });
      throw error;
    }

    const context = {
      requestId,
      offering: offering.code,
      feeSchedule: offering.feeSchedule,
      entryPoint,
      registration: funding.registration,
      fundingMethod: funding.method,
      initialDeposit: funding.initialDeposit,
      requestIdentity: { devinUserId: data.devinUserId || '', devinOrgId: data.devinOrgId || '', devinEmail: data.devinEmail || '' },
    };

    Sentry.captureException(error, {
      tags: {
        route: ROUTE, service: SERVICE, customer: CUSTOMER, offering: offering.code, alert_path: 'instant',
      },
      extra: context,
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/549ee872.js — startApplication',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: OWNER.devinUserId,
      devinOrgId: OWNER.devinOrgId,
      customer: CUSTOMER,
      slackMemberId: OWNER.slackMemberId,
      slackMemberIdFallback: OWNER.slackMemberId,
      service: SERVICE,
      verticalLabel: 'Fidelity — Homepage Account Opening',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'offering', value: offering.code },
        { key: 'fee_schedule', value: offering.feeSchedule },
        { key: 'entry_point', value: entryPoint },
      ],
      extra: {
        ...context,
        promptContext: 'Every call to action on the fidelity.com homepage (Open an account, Log in, Open a brokerage account, Open a Roth IRA, Open an HSA, Find an advisor, the navigation links and the learn cards) starts an account application and every application fails with HTTP 500 before fees are estimated, so no visitor can open an account or reach a product page.',
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@5.2.0`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
      promptAppendix: 'When you fix this, add a regression test that builds one application for every offering in the catalog, and record a browser video of /549ee872 showing Open an account succeeding.',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session', { error: err.message, requestId });
    });

    throw error;
  }
}

module.exports = { startApplication, buildApplication, normalizeFunding, OWNER };
