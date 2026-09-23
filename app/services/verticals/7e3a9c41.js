const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/7e3a9c41/adjudicate';
const SERVICE = 'healthedge-healthrules-adjudication';
const SLACK_MEMBER_ID = process.env.HEALTHEDGE_SLACK_MEMBER_ID || 'U08S7AVJ478';

/**
 * Lines of business the plan runs on HealthRules Payer.
 */
const LINES_OF_BUSINESS = {
  commercial: { label: 'Commercial', network: 'HR National PPO' },
  medicare_advantage: { label: 'Medicare Advantage', network: 'HR Medicare Complete' },
  medicaid: { label: 'Medicaid', network: 'HR State Medicaid' },
  dental: { label: 'Dental', network: 'HR Dental Select' },
};

/**
 * Fee schedules keyed by line of business. Each schedule carries the allowed
 * amounts per procedure code and the plan cost-share applied during
 * adjudication.
 */
const LOB_FEE_SCHEDULES = {
  commercial: {
    rateTable: { '99213': 132.0, '99214': 192.5, '71046': 88.0, D0120: 46.0 },
    planSharePct: 80,
  },
  medicare_adv: {
    rateTable: { '99213': 98.4, '99214': 141.2, '71046': 64.75, D0120: 31.5 },
    planSharePct: 90,
  },
  medicaid: {
    rateTable: { '99213': 71.5, '99214': 104.0, '71046': 52.25, D0120: 24.0 },
    planSharePct: 100,
  },
  dental: {
    rateTable: { '99213': 0, '99214': 0, '71046': 0, D0120: 58.0 },
    planSharePct: 100,
  },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the HealthEdge HealthRules Payer claims adjudication demo:',
  '- Service: `app/services/verticals/7e3a9c41.js`',
  '- Route: `app/routes/verticals/7e3a9c41.js`',
  '- Page: `app/public/verticals/7e3a9c41.html` (served at `/healthedge`)',
  '',
  'Preserve the existing behavior for every line of business that adjudicates today.',
  'Verify the adjudication form at `/healthedge` pays claims for every selectable line of business.',
  'Open a pull request against `main` with the fix.',
].join('\n');

function round2(n) {
  return Math.round(n * 100) / 100;
}

function claimId() {
  return `HR-${uuidv4().slice(0, 8).toUpperCase()}`;
}

/**
 * Adjudicates one professional claim against the fee schedule for the
 * submitted line of business.
 */
async function adjudicateClaim(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Adjudicating HealthRules claim', {
    requestId,
    lineOfBusiness: data.lineOfBusiness,
    memberId: data.memberId,
    procedureCode: data.procedureCode,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 100));

    const schedule = LOB_FEE_SCHEDULES[data.lineOfBusiness];
    const allowedAmount = schedule.rateTable[data.procedureCode];
    if (allowedAmount === undefined || allowedAmount === 0) {
      throw Object.assign(new Error(`Procedure ${data.procedureCode} is not covered under ${data.lineOfBusiness}`), { code: 'NOT_COVERED' });
    }

    const billedAmount = Number(data.billedAmount);
    const allowed = round2(Math.min(billedAmount, allowedAmount));
    const planPaid = round2((allowed * schedule.planSharePct) / 100);
    const memberLiability = round2(allowed - planPaid);

    const duration = Date.now() - startTime;

    incrementMetric('claim.adjudicate.success', {
      route: ROUTE,
      lineOfBusiness: data.lineOfBusiness,
      procedureCode: data.procedureCode,
    });
    recordTiming('claim.adjudicate.latency', duration, { route: ROUTE });

    return {
      success: true,
      claim: {
        claimId: claimId(),
        status: 'PAID',
        allowedAmount: allowed,
        planPaid,
        memberLiability,
        adjudicatedIn: `${duration}ms`,
        autoAdjudicated: true,
      },
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('claim.adjudicate.failure', {
      route: ROUTE,
      errorClass: error.name,
      lineOfBusiness: data.lineOfBusiness,
      procedureCode: data.procedureCode,
    });
    recordTiming('claim.adjudicate.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('HealthRules claim adjudication failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      lineOfBusiness: data.lineOfBusiness,
      memberId: data.memberId,
      procedureCode: data.procedureCode,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        source: 'healthedge-healthrules',
        alert_path: 'instant',
      },
      extra: {
        requestId,
        lineOfBusiness: data.lineOfBusiness,
        memberId: data.memberId,
        procedureCode: data.procedureCode,
        billedAmount: data.billedAmount,
        providerNpi: data.providerNpi,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/7e3a9c41.js \u2014 adjudicateClaim',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: '7e3a9c41',
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      service: SERVICE,
      verticalLabel: 'HealthEdge \u2014 HealthRules Payer Claims Adjudication',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
      ],
      extra: {
        requestId,
        lineOfBusiness: data.lineOfBusiness,
        memberId: data.memberId,
        procedureCode: data.procedureCode,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@1.0.0`,
      promptAppendix: REMEDIATION_DIRECTIVE,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from HealthRules adjudication error', { error: err.message });
    });

    throw error;
  }
}

module.exports = {
  adjudicateClaim,
  LINES_OF_BUSINESS,
  LOB_FEE_SCHEDULES,
  REMEDIATION_DIRECTIVE,
};
