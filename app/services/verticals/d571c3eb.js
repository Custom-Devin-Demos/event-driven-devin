const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/d571c3eb/prior-auth';
const SERVICE = 'd571c3eb-prior-auth-api';

/** Fictional members — demo data only. */
const MEMBERS = {
  'SHP-448210': { name: 'Jordan Rivera', plan: 'BlueOptions Gold PPO', group: 'GRP-7781' },
  'SHP-448377': { name: 'Priya Natarajan', plan: 'BlueCare Silver HMO', group: 'GRP-7781' },
};

const PROCEDURES = {
  72148: 'MRI lumbar spine without contrast',
  29881: 'Knee arthroscopy with meniscectomy',
  97110: 'Physical therapy — therapeutic exercise',
};

/** CMS place-of-service codes → site-of-service keys used by the criteria table. */
const PLACE_OF_SERVICE = {
  11: 'office',
  22: 'outpatient-hospital',
  24: 'ambulatory-surgical-center',
};

/**
 * Clinical review criteria keyed by `${cpt}:${siteOfService}`.
 */
const CLINICAL_CRITERIA = {
  '72148:office': { autoApprove: true, requiredDocs: ['6 weeks conservative therapy'], turnaroundHours: 0 },
  '72148:outpatient_hospital': { autoApprove: false, requiredDocs: ['6 weeks conservative therapy', 'Neurologic deficit note'], turnaroundHours: 72 },
  '29881:ambulatory-surgical-center': { autoApprove: false, requiredDocs: ['MRI report', 'Ortho consult note'], turnaroundHours: 48 },
  '97110:office': { autoApprove: true, requiredDocs: ['Plan of care'], turnaroundHours: 0 },
};

function siteOfServiceFor(posCode) {
  return PLACE_OF_SERVICE[posCode] || String(posCode);
}

function criteriaFor(cpt, posCode) {
  return CLINICAL_CRITERIA[`${cpt}:${siteOfServiceFor(posCode)}`];
}

function decide(criteria, attachedDocs) {
  const missing = criteria.requiredDocs.filter((d) => !attachedDocs.includes(d));
  if (missing.length) return { status: 'pended', reason: 'Missing documentation', missing };
  if (criteria.autoApprove) return { status: 'approved', reason: 'Meets clinical criteria' };
  return { status: 'in-clinical-review', reason: `Nurse review within ${criteria.turnaroundHours}h` };
}

class ValidationError extends Error {
  constructor(message) { super(message); this.name = 'ValidationError'; }
}

async function submitPriorAuth(data) {
  const startTime = Date.now();
  const requestId = `PA-${uuidv4().slice(0, 8).toUpperCase()}`;
  logger.info('Submitting prior authorization', { requestId, memberId: data.memberId, cpt: data.cpt, pos: data.placeOfService, service: SERVICE });

  const member = MEMBERS[data.memberId];
  if (!member) throw new ValidationError('Member not found');
  if (!PROCEDURES[data.cpt]) throw new ValidationError('Unknown procedure code');

  try {
    const criteria = criteriaFor(data.cpt, data.placeOfService);
    const decision = decide(criteria, data.attachedDocs || []);
    incrementMetric('prior_auth.success', { route: ROUTE, status: decision.status });
    recordTiming('prior_auth.latency', Date.now() - startTime, { route: ROUTE });
    return {
      success: true, requestId, member: member.name, plan: member.plan,
      procedure: `${data.cpt} — ${PROCEDURES[data.cpt]}`,
      siteOfService: siteOfServiceFor(data.placeOfService), ...decision,
      submittedAt: new Date().toISOString(),
    };
  } catch (error) {
    incrementMetric('prior_auth.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('prior_auth.latency', Date.now() - startTime, { route: ROUTE, error: 'true' });
    logger.error('Prior authorization failed', { requestId, error: error.message, errorClass: error.name, cpt: data.cpt, pos: data.placeOfService });
    Sentry.captureException(error, { tags: { route: ROUTE, service: SERVICE, cpt: String(data.cpt), pos: String(data.placeOfService), alert_path: 'instant' }, extra: { requestId, memberId: data.memberId } });
    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/d571c3eb.js — submitPriorAuth',
      errorType: error.name || 'Error', errorValue: error.message,
      devinUserId: data.devinUserId, devinEmail: data.devinEmail, devinOrgId: data.devinOrgId, devinName: data.devinName,
      service: SERVICE, verticalLabel: 'Florida Blue — Prior Authorization (Payer)', customer: 'd571c3eb',
      tags: [{ key: 'route', value: ROUTE }, { key: 'service', value: SERVICE }, { key: 'cpt', value: String(data.cpt) }, { key: 'placeOfService', value: String(data.placeOfService) }],
      extra: { requestId, memberId: data.memberId },
      level: 'error', platform: 'node', firstSeen: '', lastSeen: new Date().toISOString(), count: '', shortId: '',
      project: 'event-driven-devin', release: process.env.SENTRY_RELEASE || 'd571c3eb@1.0.0',
      environment: process.env.DD_ENV || 'prod', triggeredRule: '',
    }).catch((err) => logger.error('Failed to trigger Devin session from prior-auth error', { error: err.message }));
    throw error;
  }
}

module.exports = { submitPriorAuth, criteriaFor, siteOfServiceFor, MEMBERS, PROCEDURES, CLINICAL_CRITERIA, ValidationError };
