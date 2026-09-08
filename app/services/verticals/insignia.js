const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const MEMBER_ACCOUNTS = {
  '4471902883': {
    memberAccountId: '4471902883',
    memberNumber: 'EXP-4471902883',
    memberName: 'Daniel Fitzgerald',
    accountName: 'Expand Extra Super',
    productCode: 'expand_extra_super_2026',
    productLabel: 'Expand Extra Super (2026)',
    employer: 'Northbridge Logistics Pty Ltd',
    accountBalance: 284617.42,
  },
  '3390218774': {
    memberAccountId: '3390218774',
    memberNumber: 'EXP-3390218774',
    memberName: 'Priya Raghavan',
    accountName: 'Expand Essential Super',
    productCode: 'expand_essential_super',
    productLabel: 'Expand Essential Super',
    employer: 'Clareville Health Group',
    accountBalance: 96412.08,
  },
  '5102874461': {
    memberAccountId: '5102874461',
    memberNumber: 'MKP-5102874461',
    memberName: 'Geoffrey Lam',
    accountName: 'MLC MasterKey Pension',
    productCode: 'mlc_masterkey_pension',
    productLabel: 'MLC MasterKey Pension',
    employer: '',
    accountBalance: 512338.90,
  },
};

const INVESTMENT_OPTIONS = {
  'OPT-BAL': {
    optionId: 'OPT-BAL',
    name: 'MLC Horizon 4 Balanced Portfolio',
    assetClass: 'growth',
    growthWeighting: 0.70,
    managementFee: 0.0087,
  },
  'OPT-GRW': {
    optionId: 'OPT-GRW',
    name: 'MLC Horizon 5 Growth Portfolio',
    assetClass: 'growth',
    growthWeighting: 0.85,
    managementFee: 0.0094,
  },
  'OPT-IDX': {
    optionId: 'OPT-IDX',
    name: 'Insignia Index Balanced',
    assetClass: 'growth',
    growthWeighting: 0.65,
    managementFee: 0.0029,
  },
  'OPT-CASH': {
    optionId: 'OPT-CASH',
    name: 'Cash Enhanced',
    assetClass: 'defensive',
    growthWeighting: 0,
    managementFee: 0.0018,
  },
};

const ALLOCATION_SCHEDULES = {
  // expand_extra_super_2026 joins the investment menu with the 1 October 2026 option uplift; allocation schedule registration pending
  expand_essential_super: {
    label: 'Expand Essential Super',
    growthAllocationCap: 90,
    minCashAllocation: 1,
    switchesPerYear: 12,
    unitPricingQueue: 'retail-daily',
  },
  mlc_masterkey_pension: {
    label: 'MLC MasterKey Pension',
    growthAllocationCap: 75,
    minCashAllocation: 5,
    switchesPerYear: 24,
    unitPricingQueue: 'pension-priority',
  },
};

const INSIGNIA_SLACK_MEMBER_ID = process.env.INSIGNIA_SLACK_MEMBER_ID || '';
const SENTRY_ISSUE_QUERY = 'is:unresolved growthAllocationCap';

const REMEDIATION_DIRECTIVE = `Repository: COG-GTM/event-driven-devin. Scope: only the Insignia Financial super allocation failure below. This repository hosts many independent demo verticals, each with its own intentional bug and its own Sentry issues. Ignore every issue that is not from POST /api/insignia/allocation, do not investigate or modify any other vertical, and do not widen the Sentry or Datadog search beyond this route. The failing surface is the Insignia Financial Expand member portal "Change your investment mix" page at app/public/verticals/insignia.html (page route GET /insignia), whose "Submit allocation change" action posts to POST /api/insignia/allocation in app/routes/verticals/insignia.js. The allocation pipeline lives in app/services/verticals/insignia.js: submitAllocation -> calculateAllocationSplit -> resolveAllocationSchedule. Start at resolveAllocationSchedule: it looks up ALLOCATION_SCHEDULES by the member account's product code, and the expand_extra_super_2026 product joined the investment menu with the 1 October 2026 option uplift without a registered allocation schedule, so the lookup returns undefined and calculateAllocationSplit dereferences it while applying the growth allocation cap. Register the missing product's allocation schedule and make the lookup fail as a handled allocation error routed to the appropriate unit-pricing queue instead of a TypeError. Do not change the page's look and feel, do not touch the Suncorp, HCF or QBE verticals, and do not touch any other vertical. Verify by starting the server (node app/server.js) and POSTing the default allocation instruction to /api/insignia/allocation, which must return an accepted allocation change, and confirm npm run lint passes.

Verification evidence is mandatory and must be visual, not curl-only: with the server running, open the /insignia page in a real browser, submit the pre-filled allocation change for the default Expand Extra Super account, and record your screen for the whole submission so the recording shows the allocation form, the click, and the accepted allocation confirmation that replaces the previous TypeError panel. Attach a screenshot of that accepted allocation confirmation and an animated webp of the recording to the pull request under a "Fix Verification" heading, and post the same evidence as a comment on the PR. Do not report the fix as complete, and do not leave the PR description saying verification is pending, until that browser evidence is attached.`;

function resolveAllocationSchedule(account) {
  return ALLOCATION_SCHEDULES[account.productCode];
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function assignUnitPricingQueue(schedule) {
  return schedule.unitPricingQueue;
}

function validationError(message) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = 'INVALID_ALLOCATION';
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

function makeReceiptNumber() {
  const digits = uuidv4().replace(/\D/g, '').slice(0, 8).padEnd(8, '0');
  return `INS-${digits}`;
}

function calculateAllocationSplit(account, instruction) {
  const schedule = resolveAllocationSchedule(account);
  const growthAllocationCap = schedule.growthAllocationCap;
  const growthExposure = roundMoney(instruction.allocations.reduce((total, allocation) => {
    const option = INVESTMENT_OPTIONS[allocation.optionId];
    return total + (option.assetClass === 'growth' ? allocation.percentage : 0);
  }, 0));
  const defensiveExposure = roundMoney(100 - growthExposure);
  const weightedGrowthWeighting = roundMoney(instruction.allocations.reduce((total, allocation) => {
    const option = INVESTMENT_OPTIONS[allocation.optionId];
    return total + (allocation.percentage * option.growthWeighting);
  }, 0) / 100);

  const cashAllocation = roundMoney(instruction.allocations.reduce((total, allocation) => (
    total + (allocation.optionId === 'OPT-CASH' ? allocation.percentage : 0)
  ), 0));
  if (cashAllocation < schedule.minCashAllocation) {
    throw validationError(
      `Cash allocation of ${cashAllocation}% is below the minimum ${schedule.minCashAllocation}% required on ${account.productLabel}`,
    );
  }
  if (growthExposure > growthAllocationCap) {
    throw validationError(
      `Growth allocation of ${growthExposure}% exceeds the ${growthAllocationCap}% growth cap on ${account.productLabel}`,
    );
  }

  return {
    schedule,
    growthAllocationCap,
    growthExposure,
    defensiveExposure,
    weightedGrowthWeighting,
    remainingSwitches: schedule.switchesPerYear - 1,
    unitPricingQueue: assignUnitPricingQueue(schedule),
  };
}

async function submitAllocation(data) {
  const startTime = Date.now();
  const receiptNumber = makeReceiptNumber();
  const memberAccountId = data.memberAccountId;
  const account = MEMBER_ACCOUNTS[memberAccountId];
  const allocations = data.allocations;
  const contributionType = data.contributionType;
  const effectiveDate = data.effectiveDate;

  if (!memberAccountId || !String(memberAccountId).trim() || !account) {
    throw validationError(`Unknown member account: ${memberAccountId || '(none)'}`);
  }
  if (!Array.isArray(allocations) || allocations.length === 0) {
    throw validationError('At least one investment option allocation is required');
  }

  const seenOptionIds = new Set();
  for (const allocation of allocations) {
    const optionId = allocation && allocation.optionId;
    if (!optionId || !INVESTMENT_OPTIONS[optionId]) {
      throw validationError(`Unknown investment option: ${optionId || '(none)'}`);
    }
    if (seenOptionIds.has(optionId)) {
      throw validationError(`Investment option ${optionId} appears more than once`);
    }
    seenOptionIds.add(optionId);
    if (!Number.isFinite(allocation.percentage) || allocation.percentage <= 0) {
      throw validationError('Allocation percentages must be positive numbers');
    }
  }

  const allocationTotal = roundMoney(allocations.reduce(
    (total, allocation) => total + allocation.percentage,
    0,
  ));
  if (allocationTotal !== 100) {
    throw validationError(`Allocation percentages must total 100% (received ${allocationTotal}%)`);
  }
  if (!isCalendarDate(effectiveDate)) {
    throw validationError('Effective date must be a valid YYYY-MM-DD calendar date');
  }

  logger.info('Submitting Insignia allocation change', {
    receiptNumber,
    memberAccountId,
    contributionType,
    effectiveDate,
    service: 'customer-insignia-allocation',
    route: '/api/insignia/allocation',
  });

  try {
    const split = calculateAllocationSplit(account, {
      allocations,
      contributionType,
      effectiveDate,
    });
    const submittedAt = new Date().toISOString();
    const duration = Date.now() - startTime;

    incrementMetric('insignia_allocation.success', {
      route: '/api/insignia/allocation',
      productCode: account.productCode,
      contributionType,
    });
    recordTiming('insignia_allocation.latency', duration, {
      route: '/api/insignia/allocation',
    });

    return {
      success: true,
      status: 'accepted',
      receiptNumber,
      instructionReference: receiptNumber,
      memberAccountId,
      memberNumber: account.memberNumber,
      memberName: account.memberName,
      accountName: account.accountName,
      productLabel: account.productLabel,
      accountBalance: account.accountBalance,
      contributionType,
      effectiveDate,
      allocations: allocations.map((allocation) => {
        const option = INVESTMENT_OPTIONS[allocation.optionId];
        return {
          optionId: allocation.optionId,
          name: option.name,
          assetClass: option.assetClass,
          percentage: allocation.percentage,
          allocatedAmount: roundMoney(account.accountBalance * allocation.percentage / 100),
        };
      }),
      growthExposure: split.growthExposure,
      defensiveExposure: split.defensiveExposure,
      growthAllocationCap: split.growthAllocationCap,
      weightedGrowthWeighting: split.weightedGrowthWeighting,
      remainingSwitches: split.remainingSwitches,
      unitPricingQueue: split.unitPricingQueue,
      appliedAt: 'Applied at the next daily unit price',
      submittedAt,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    if (error.name === 'ValidationError') {
      incrementMetric('insignia_allocation.failure', {
        route: '/api/insignia/allocation',
        errorClass: error.name,
        productCode: account.productCode,
        contributionType,
      });
      recordTiming('insignia_allocation.latency', duration, {
        route: '/api/insignia/allocation',
        error: 'true',
      });
      throw error;
    }

    const growthRequested = allocations.reduce((total, allocation) => {
      const option = INVESTMENT_OPTIONS[allocation.optionId];
      return total + (option.assetClass === 'growth' ? allocation.percentage : 0);
    }, 0);

    incrementMetric('insignia_allocation.failure', {
      route: '/api/insignia/allocation',
      errorClass: error.name,
      productCode: account.productCode,
      contributionType,
    });
    recordTiming('insignia_allocation.latency', duration, {
      route: '/api/insignia/allocation',
      error: 'true',
    });

    logger.error('Insignia allocation change failed', {
      receiptNumber,
      memberAccountId,
      contributionType,
      effectiveDate,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: 'customer-insignia-allocation',
      route: '/api/insignia/allocation',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/insignia/allocation',
        service: 'customer-insignia-allocation',
        productCode: account.productCode,
        productLabel: account.productLabel,
        contributionType,
      },
      extra: {
        receiptNumber,
        instructionReference: receiptNumber,
        memberNumber: account.memberNumber,
        memberName: account.memberName,
        growthRequested,
        effectiveDate,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=${encodeURIComponent(SENTRY_ISSUE_QUERY)}`,
      culprit: 'app/services/verticals/insignia.js — calculateAllocationSplit',
      errorType: error.name || 'Error',
      errorValue: error.message,
      service: 'customer-insignia-allocation',
      verticalLabel: 'Insignia Financial — Expand Super Investment Allocation',
      customer: 'insignia',
      slackMemberId: data.devinEmail ? '' : INSIGNIA_SLACK_MEMBER_ID,
      slackMemberIdFallback: INSIGNIA_SLACK_MEMBER_ID,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: [
        { key: 'route', value: '/api/insignia/allocation' },
        { key: 'service', value: 'customer-insignia-allocation' },
        { key: 'productCode', value: account.productCode },
        { key: 'productLabel', value: account.productLabel },
        { key: 'contributionType', value: contributionType },
      ],
      extra: {
        receiptNumber,
        instructionReference: receiptNumber,
        memberNumber: account.memberNumber,
        memberName: account.memberName,
        growthRequested,
        effectiveDate,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: 'customer-insignia-allocation@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for Insignia allocation error', {
        receiptNumber,
        error: alertError.message,
      });
    });

    throw error;
  }
}

module.exports = {
  submitAllocation,
  resolveAllocationSchedule,
  calculateAllocationSplit,
  assignUnitPricingQueue,
  roundMoney,
  MEMBER_ACCOUNTS,
  INVESTMENT_OPTIONS,
  ALLOCATION_SCHEDULES,
  REMEDIATION_DIRECTIVE,
};
