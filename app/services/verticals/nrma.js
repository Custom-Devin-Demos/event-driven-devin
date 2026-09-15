const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const POLICIES = {
  'NRMA-HM-7741820': {
    policyNumber: 'NRMA-HM-7741820',
    policyholderName: 'Priya Raghunathan',
    productCode: 'nrma_home_buildings_contents_advantage',
    productLabel: 'Home Buildings & Contents Insurance — Advantage',
    situationAddress: '14 Wentworth Avenue, Randwick NSW 2031',
    buildingSumInsured: 1180000,
    contentsSumInsured: 165000,
    coverStartDate: '2026-03-01',
    brand: 'NRMA Insurance',
    underwriter: 'Insurance Australia Limited (IAG)',
  },
  'NRMA-HM-3308471': {
    policyNumber: 'NRMA-HM-3308471',
    policyholderName: 'Desmond Whitlock',
    productCode: 'nrma_home_buildings_essentials',
    productLabel: 'Home Buildings Insurance — Essentials',
    situationAddress: '52 Kanangra Crescent, Ryde NSW 2112',
    buildingSumInsured: 890000,
    contentsSumInsured: 0,
    coverStartDate: '2025-11-14',
    brand: 'NRMA Insurance',
    underwriter: 'Insurance Australia Limited (IAG)',
  },
  'NRMA-HM-9925634': {
    policyNumber: 'NRMA-HM-9925634',
    policyholderName: 'Alira Tuinukuafe',
    productCode: 'nrma_home_contents_complete',
    productLabel: 'Home Contents Insurance — Complete',
    situationAddress: '7/210 Barkly Street, Footscray VIC 3011',
    buildingSumInsured: 0,
    contentsSumInsured: 240000,
    coverStartDate: '2026-01-09',
    brand: 'NRMA Insurance',
    underwriter: 'Insurance Australia Limited (IAG)',
  },
};

const EXCESS_SCHEDULE = {
  // nrma_home_buildings_contents_advantage moved to the FY26 combined-home excess schedule; registration pending
  nrma_home_buildings_essentials: {
    label: 'Home Buildings Insurance — Essentials',
    stormExcessAmount: 500,
    standardExcessAmount: 500,
    makeSafeAllowance: 1500,
    assessorRequiredAbove: 20000,
    assessmentDays: 5,
    lodgementQueue: 'home-essentials-daily',
  },
  nrma_home_contents_complete: {
    label: 'Home Contents Insurance — Complete',
    stormExcessAmount: 400,
    standardExcessAmount: 400,
    makeSafeAllowance: 1000,
    assessorRequiredAbove: 15000,
    assessmentDays: 3,
    lodgementQueue: 'contents-complete-daily',
  },
};

const NRMA_SLACK_MEMBER_ID = process.env.NRMA_SLACK_MEMBER_ID || '';
const SENTRY_ISSUE_QUERY = 'is:unresolved stormExcessAmount';

const REMEDIATION_DIRECTIVE = `Repository: COG-GTM/event-driven-devin. Scope: only the NRMA Insurance home claim lodgement failure below. This repository hosts many independent demo verticals, each with its own intentional bug and its own Sentry issues. Ignore every issue that is not from POST /api/nrma/claim, do not investigate or modify any other vertical, and do not widen the Sentry or Datadog search beyond this route. Explicitly exclude QBE, HCF, Suncorp, Insignia, HUB24, CFS, Morgan Stanley, and every unrelated vertical. The failing surface is the NRMA Insurance home claims page at app/public/verticals/nrma.html (page route GET /nrma), whose "Lodge claim" action posts to POST /api/nrma/claim in app/routes/verticals/nrma.js. The home claim settlement pipeline lives in app/services/verticals/nrma.js: submitClaim -> calculateClaimSettlement -> resolveExcessSchedule. Start at resolveExcessSchedule: it looks up EXCESS_SCHEDULE by the policy product code, and nrma_home_buildings_contents_advantage is intentionally absent because it moved to the FY26 combined-home excess schedule, so the lookup returns undefined and calculateClaimSettlement dereferences it while applying the storm excess. Fix this by registering the missing nrma_home_buildings_contents_advantage excess-schedule entry; do not patch around the crash or modify any other vertical. Verify by starting the server (node app/server.js), curling POST /api/nrma/claim, and confirming npm run lint passes. Visual Fix Verification is mandatory: open the NRMA page in a real browser, submit an accepted home claim after the fix, and capture browser evidence showing the claim form, the Lodge claim action, and the accepted confirmation.`;

function resolveExcessSchedule(policy) {
  return EXCESS_SCHEDULE[policy.productCode];
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function validationError(message) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = 'INVALID_CLAIM_REQUEST';
  error.statusCode = 400;
  return error;
}

function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function makeClaimReference() {
  const digits = uuidv4().replace(/\D/g, '').slice(0, 10).padEnd(10, '0');
  return `NRMA-CLM-${digits}`;
}

function makeReceiptNumber() {
  const digits = uuidv4().replace(/\D/g, '').slice(0, 8).padEnd(8, '0');
  return `NRMA-${digits}`;
}

function addBusinessishDays(dateValue, days) {
  const date = new Date(`${dateValue}T00:00:00.000Z`);
  let remaining = days;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return date.toISOString().slice(0, 10);
}

function calculateClaimSettlement(policy, claim) {
  const schedule = resolveExcessSchedule(policy);
  const stormExcessAmount = schedule.stormExcessAmount;
  const applicableExcess = claim.incidentType === 'storm'
    ? stormExcessAmount
    : schedule.standardExcessAmount;
  const settlementEstimate = roundMoney(
    Math.max(claim.estimatedRepairCost - applicableExcess, 0),
  );
  const assessorRequired = claim.estimatedRepairCost > schedule.assessorRequiredAbove;
  const makeSafeAllowance = claim.makeSafeRequired ? schedule.makeSafeAllowance : 0;

  return {
    schedule,
    applicableExcess,
    settlementEstimate,
    assessorRequired,
    makeSafeAllowance,
    estimatedAssessmentDate: addBusinessishDays(claim.incidentDate, schedule.assessmentDays),
    lodgementQueue: schedule.lodgementQueue,
    appliedAtText: `Claim lodged for assessment from ${claim.incidentDate}`,
  };
}

async function submitClaim(data) {
  const startTime = Date.now();
  const claimReference = makeClaimReference();
  const receiptNumber = makeReceiptNumber();
  const policyNumber = data.policyNumber;
  const policy = POLICIES[policyNumber];
  const incidentType = data.incidentType;
  const incidentDate = data.incidentDate;
  const estimatedRepairCost = data.estimatedRepairCost;
  const damageDescription = data.damageDescription;
  const affectedItems = data.affectedItems;
  const makeSafeRequired = data.makeSafeRequired;
  const contactNumber = data.contactNumber;
  const policyholderDeclaration = data.policyholderDeclaration;

  if (!policyNumber || !String(policyNumber).trim() || !policy) {
    throw validationError(`Unknown policy number: ${policyNumber || '(none)'}`);
  }
  if (!['storm', 'fire', 'theft', 'accidental-damage', 'water'].includes(incidentType)) {
    throw validationError('Incident type must be storm, fire, theft, accidental-damage or water');
  }
  if (!Number.isFinite(estimatedRepairCost) || estimatedRepairCost <= 0) {
    throw validationError('Estimated repair cost must be a positive number');
  }
  if (typeof damageDescription !== 'string' || !damageDescription.trim()) {
    throw validationError('Damage description is required');
  }
  if (!isCalendarDate(incidentDate)) {
    throw validationError('Incident date must be a valid YYYY-MM-DD calendar date');
  }
  if (policyholderDeclaration !== true) {
    throw validationError('Policyholder declaration is required before a claim can be lodged');
  }
  const totalSumInsured = policy.buildingSumInsured + policy.contentsSumInsured;
  if (estimatedRepairCost > totalSumInsured) {
    throw validationError(
      `Estimated repair cost exceeds the $${totalSumInsured.toFixed(2)} total sum insured`,
    );
  }

  logger.info('Submitting NRMA home claim', {
    claimReference,
    receiptNumber,
    policyNumber,
    incidentType,
    incidentDate,
    estimatedRepairCost,
    damageDescription,
    affectedItems,
    makeSafeRequired,
    contactNumber,
    channel: data.channel,
    service: 'customer-nrma-claims',
    route: '/api/nrma/claim',
  });

  try {
    const settlement = calculateClaimSettlement(policy, {
      incidentType,
      incidentDate,
      estimatedRepairCost,
      makeSafeRequired,
    });
    const submittedAt = new Date().toISOString();
    const duration = Date.now() - startTime;

    incrementMetric('nrma_claim.success', {
      route: '/api/nrma/claim',
      productCode: policy.productCode,
      incidentType,
    });
    recordTiming('nrma_claim.latency', duration, {
      route: '/api/nrma/claim',
    });

    return {
      success: true,
      status: 'accepted',
      claimReference,
      receiptNumber,
      policyNumber,
      policyholderName: policy.policyholderName,
      productLabel: policy.productLabel,
      situationAddress: policy.situationAddress,
      buildingSumInsured: policy.buildingSumInsured,
      contentsSumInsured: policy.contentsSumInsured,
      brand: policy.brand,
      underwriter: policy.underwriter,
      incidentType,
      incidentDate,
      estimatedRepairCost,
      damageDescription,
      affectedItems,
      makeSafeRequired,
      contactNumber,
      applicableExcess: settlement.applicableExcess,
      settlementEstimate: settlement.settlementEstimate,
      assessorRequired: settlement.assessorRequired,
      makeSafeAllowance: settlement.makeSafeAllowance,
      estimatedAssessmentDate: settlement.estimatedAssessmentDate,
      lodgementQueue: settlement.lodgementQueue,
      appliedAtText: settlement.appliedAtText,
      submittedAt,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    if (error.name === 'ValidationError') {
      incrementMetric('nrma_claim.failure', {
        route: '/api/nrma/claim',
        errorClass: error.name,
        productCode: policy.productCode,
        incidentType,
      });
      recordTiming('nrma_claim.latency', duration, {
        route: '/api/nrma/claim',
        error: 'true',
      });
      throw error;
    }

    incrementMetric('nrma_claim.failure', {
      route: '/api/nrma/claim',
      errorClass: error.name,
      productCode: policy.productCode,
      incidentType,
    });
    recordTiming('nrma_claim.latency', duration, {
      route: '/api/nrma/claim',
      error: 'true',
    });

    logger.error('NRMA home claim failed', {
      claimReference,
      receiptNumber,
      policyNumber,
      incidentType,
      incidentDate,
      estimatedRepairCost,
      damageDescription,
      affectedItems,
      makeSafeRequired,
      contactNumber,
      channel: data.channel,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: 'customer-nrma-claims',
      route: '/api/nrma/claim',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/nrma/claim',
        service: 'customer-nrma-claims',
        productCode: policy.productCode,
        productLabel: policy.productLabel,
        incidentType,
      },
      extra: {
        claimReference,
        receiptNumber,
        policyNumber,
        policyholderName: policy.policyholderName,
        incidentDate,
        estimatedRepairCost,
        damageDescription,
        affectedItems,
        makeSafeRequired,
        contactNumber,
        channel: data.channel,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=${encodeURIComponent(SENTRY_ISSUE_QUERY)}`,
      culprit: 'app/services/verticals/nrma.js — calculateClaimSettlement',
      errorType: error.name || 'Error',
      errorValue: error.message,
      service: 'customer-nrma-claims',
      verticalLabel: 'NRMA Insurance — Home Claim Lodgement (IAG)',
      customer: 'nrma',
      slackMemberId: data.devinEmail ? '' : NRMA_SLACK_MEMBER_ID,
      slackMemberIdFallback: NRMA_SLACK_MEMBER_ID,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: [
        { key: 'route', value: '/api/nrma/claim' },
        { key: 'service', value: 'customer-nrma-claims' },
        { key: 'productCode', value: policy.productCode },
        { key: 'productLabel', value: policy.productLabel },
        { key: 'incidentType', value: incidentType },
      ],
      extra: {
        claimReference,
        receiptNumber,
        policyNumber,
        policyholderName: policy.policyholderName,
        incidentDate,
        estimatedRepairCost,
        damageDescription,
        affectedItems,
        makeSafeRequired,
        contactNumber,
        channel: data.channel,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: 'customer-nrma-claims@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for NRMA claim error', {
        claimReference,
        error: alertError.message,
      });
    });

    throw error;
  }
}

module.exports = {
  submitClaim,
  resolveExcessSchedule,
  calculateClaimSettlement,
  roundMoney,
  isCalendarDate,
  POLICIES,
  EXCESS_SCHEDULE,
  REMEDIATION_DIRECTIVE,
};
