const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const CLIENT_ACCOUNTS = {
  'HUB24-8842167': {
    clientAccountId: 'HUB24-8842167',
    clientName: 'Marcus Alderton',
    productCode: 'hub24_super_choice',
    productLabel: 'HUB24 Super — Choice',
    portfolioValue: 1482350.60,
    adviser: 'Rebecca Tran · Ardenmore Private Wealth',
    afsl: 'AFSL 241 062',
  },
  'HUB24-5510934': {
    clientAccountId: 'HUB24-5510934',
    clientName: 'Priya Raghavan',
    productCode: 'hub24_invest_ideal',
    productLabel: 'HUB24 Invest — IDEAL',
    portfolioValue: 612904.15,
    adviser: 'Rebecca Tran · Ardenmore Private Wealth',
    afsl: 'AFSL 241 062',
  },
  'HUB24-3307418': {
    clientAccountId: 'HUB24-3307418',
    clientName: 'Geoffrey Holt',
    productCode: 'hub24_super_pension',
    productLabel: 'HUB24 Super — Pension',
    portfolioValue: 938117.80,
    adviser: 'Rebecca Tran · Ardenmore Private Wealth',
    afsl: 'AFSL 241 062',
  },
};

const FEE_SCHEDULES = {
  // hub24_super_choice joined the adviser-fee menu with the FY26 consent refresh; schedule registration pending
  hub24_invest_ideal: {
    label: 'HUB24 Invest — IDEAL',
    maxOngoingFeePercent: 1.1,
    maxFlatFeeAnnual: 16500,
    minPortfolioValue: 50000,
    consentRenewalMonths: 12,
    feeRunQueue: 'invest-monthly',
  },
  hub24_super_pension: {
    label: 'HUB24 Super — Pension',
    maxOngoingFeePercent: 0.9,
    maxFlatFeeAnnual: 12000,
    minPortfolioValue: 100000,
    consentRenewalMonths: 12,
    feeRunQueue: 'super-pension-monthly',
  },
};

const FREQUENCY_OPTIONS = [
  { value: 'monthly', label: 'Monthly', periodsPerYear: 12 },
  { value: 'quarterly', label: 'Quarterly', periodsPerYear: 4 },
  { value: 'annually', label: 'Annually', periodsPerYear: 1 },
];

const HUB24_SLACK_MEMBER_ID = process.env.HUB24_SLACK_MEMBER_ID || '';
const SENTRY_ISSUE_QUERY = 'is:unresolved maxOngoingFeePercent';

const REMEDIATION_DIRECTIVE = `Repository: COG-GTM/event-driven-devin. Scope: only the HUB24 ongoing adviser fee arrangement failure below. This repository hosts many independent demo verticals, each with its own intentional bug and its own Sentry issues. Ignore every issue that is not from POST /api/hub24/fee-arrangement, do not investigate or modify any other vertical, and do not widen the Sentry or Datadog search beyond this route. Explicitly ignore QBE, HCF, Suncorp, Insignia, Morgan Stanley, and every unrelated vertical. The failing surface is the HUB24 Adviser Desktop ongoing fee arrangement page at app/public/verticals/hub24.html (page route GET /hub24), whose "Submit fee arrangement" action posts to POST /api/hub24/fee-arrangement in app/routes/verticals/hub24.js. The fee-consent pipeline lives in app/services/verticals/hub24.js: submitFeeArrangement -> calculateAdviserFeeArrangement -> resolveFeeSchedule. Start at resolveFeeSchedule: it looks up FEE_SCHEDULES by the client account's product code, and the hub24_super_choice product is intentionally absent, so the lookup returns undefined and calculateAdviserFeeArrangement dereferences it while applying the maximum ongoing fee percentage. Fix this by registering the missing hub24_super_choice fee schedule; do not patch around the crash or modify any other vertical. Verify by starting the server (node app/server.js), curling POST /api/hub24/fee-arrangement, and confirming npm run lint passes. Visual Fix Verification is mandatory: open the HUB24 page in a real browser, submit an accepted fee arrangement after the fix, and capture browser evidence showing the adviser desktop form, the submit action, and the accepted confirmation. Attach a screenshot and animated WebP recording under a "Fix Verification" heading on the pull request.`;

function resolveFeeSchedule(account) {
  return FEE_SCHEDULES[account.productCode];
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function roundPercent(value) {
  return Math.round(value * 100) / 100;
}

function validationError(message) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = 'INVALID_FEE_ARRANGEMENT';
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
  return `HUB-${digits}`;
}

function makeFeeArrangementReference() {
  const digits = uuidv4().replace(/\D/g, '').slice(0, 10).padEnd(10, '0');
  return `HUB24-FEE-${digits}`;
}

function addMonths(dateValue, months) {
  const date = new Date(`${dateValue}T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

function getFrequencyOption(frequency) {
  return FREQUENCY_OPTIONS.find((option) => option.value === frequency);
}

function calculateAdviserFeeArrangement(account, arrangement) {
  const schedule = resolveFeeSchedule(account);
  const maxOngoingFeePercent = schedule.maxOngoingFeePercent;
  const annualFeeAmount = arrangement.feeBasis === 'percentage'
    ? roundMoney(account.portfolioValue * arrangement.feeAmount / 100)
    : roundMoney(arrangement.feeAmount);
  const effectiveFeePercent = roundPercent(annualFeeAmount / account.portfolioValue * 100);
  const frequency = getFrequencyOption(arrangement.frequency);

  if (arrangement.feeBasis === 'flat' && annualFeeAmount > schedule.maxFlatFeeAnnual) {
    throw validationError(
      `Annual fee of $${annualFeeAmount} exceeds the $${schedule.maxFlatFeeAnnual} maximum on ${account.productLabel}`,
    );
  }
  if (effectiveFeePercent > maxOngoingFeePercent) {
    throw validationError(
      `Ongoing fee of ${effectiveFeePercent}% exceeds the ${maxOngoingFeePercent}% maximum on ${account.productLabel}`,
    );
  }
  if (account.portfolioValue < schedule.minPortfolioValue) {
    throw validationError(
      `Portfolio value of $${account.portfolioValue.toFixed(2)} is below the $${schedule.minPortfolioValue} minimum for ${account.productLabel}`,
    );
  }

  return {
    schedule,
    maxOngoingFeePercent,
    annualFeeAmount,
    perPeriodFeeAmount: roundMoney(annualFeeAmount / frequency.periodsPerYear),
    effectiveFeePercent,
    consentExpiryDate: addMonths(arrangement.startDate, schedule.consentRenewalMonths),
    feeRunQueue: schedule.feeRunQueue,
    appliedAtText: `Applied on the next ${frequency.label.toLowerCase()} fee run`,
  };
}

async function submitFeeArrangement(data) {
  const startTime = Date.now();
  const receiptNumber = makeReceiptNumber();
  const feeArrangementReference = makeFeeArrangementReference();
  const clientAccountId = data.clientAccountId;
  const account = CLIENT_ACCOUNTS[clientAccountId];
  const feeBasis = data.feeBasis;
  const feeAmount = data.feeAmount;
  const frequency = data.frequency;
  const startDate = data.startDate;
  const clientConsent = data.clientConsent;

  if (!clientAccountId || !String(clientAccountId).trim() || !account) {
    throw validationError(`Unknown client account: ${clientAccountId || '(none)'}`);
  }
  if (!['percentage', 'flat'].includes(feeBasis)) {
    throw validationError('Fee basis must be percentage or flat');
  }
  if (!Number.isFinite(feeAmount) || feeAmount <= 0) {
    throw validationError('Fee amount must be a positive number');
  }
  if (feeBasis === 'percentage' && feeAmount > 100) {
    throw validationError('Percentage fee amount cannot exceed 100%');
  }
  if (!getFrequencyOption(frequency)) {
    throw validationError('Frequency must be monthly, quarterly, or annually');
  }
  if (!isCalendarDate(startDate)) {
    throw validationError('Start date must be a valid YYYY-MM-DD calendar date');
  }
  if (clientConsent !== true) {
    throw validationError('Client consent is required before an ongoing fee arrangement can start');
  }

  logger.info('Submitting HUB24 fee arrangement', {
    receiptNumber,
    feeArrangementReference,
    clientAccountId,
    feeBasis,
    feeAmount,
    frequency,
    startDate,
    channel: data.channel,
    service: 'customer-hub24-fee-arrangement',
    route: '/api/hub24/fee-arrangement',
  });

  try {
    const arrangement = calculateAdviserFeeArrangement(account, {
      feeBasis,
      feeAmount,
      frequency,
      startDate,
    });
    const submittedAt = new Date().toISOString();
    const duration = Date.now() - startTime;

    incrementMetric('hub24_fee_arrangement.success', {
      route: '/api/hub24/fee-arrangement',
      productCode: account.productCode,
      feeBasis,
      frequency,
    });
    recordTiming('hub24_fee_arrangement.latency', duration, {
      route: '/api/hub24/fee-arrangement',
    });

    return {
      success: true,
      status: 'accepted',
      feeArrangementReference,
      receiptNumber,
      clientAccountId,
      clientName: account.clientName,
      productLabel: account.productLabel,
      portfolioValue: account.portfolioValue,
      feeBasis,
      annualFeeAmount: arrangement.annualFeeAmount,
      perPeriodFeeAmount: arrangement.perPeriodFeeAmount,
      effectiveFeePercent: arrangement.effectiveFeePercent,
      maxOngoingFeePercent: arrangement.maxOngoingFeePercent,
      frequency,
      startDate,
      clientConsent,
      consentExpiryDate: arrangement.consentExpiryDate,
      feeRunQueue: arrangement.feeRunQueue,
      appliedAtText: arrangement.appliedAtText,
      submittedAt,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    if (error.name === 'ValidationError') {
      incrementMetric('hub24_fee_arrangement.failure', {
        route: '/api/hub24/fee-arrangement',
        errorClass: error.name,
        productCode: account.productCode,
        feeBasis,
        frequency,
      });
      recordTiming('hub24_fee_arrangement.latency', duration, {
        route: '/api/hub24/fee-arrangement',
        error: 'true',
      });
      throw error;
    }

    incrementMetric('hub24_fee_arrangement.failure', {
      route: '/api/hub24/fee-arrangement',
      errorClass: error.name,
      productCode: account.productCode,
      feeBasis,
      frequency,
    });
    recordTiming('hub24_fee_arrangement.latency', duration, {
      route: '/api/hub24/fee-arrangement',
      error: 'true',
    });

    logger.error('HUB24 fee arrangement failed', {
      receiptNumber,
      feeArrangementReference,
      clientAccountId,
      feeBasis,
      feeAmount,
      frequency,
      startDate,
      channel: data.channel,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: 'customer-hub24-fee-arrangement',
      route: '/api/hub24/fee-arrangement',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/hub24/fee-arrangement',
        service: 'customer-hub24-fee-arrangement',
        productCode: account.productCode,
        productLabel: account.productLabel,
        feeBasis,
        frequency,
      },
      extra: {
        receiptNumber,
        feeArrangementReference,
        clientAccountId,
        clientName: account.clientName,
        feeAmount,
        startDate,
        channel: data.channel,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=${encodeURIComponent(SENTRY_ISSUE_QUERY)}`,
      culprit: 'app/services/verticals/hub24.js — calculateAdviserFeeArrangement',
      errorType: error.name || 'Error',
      errorValue: error.message,
      service: 'customer-hub24-fee-arrangement',
      verticalLabel: 'HUB24 — Adviser Fee Arrangement (Adviser Desktop)',
      customer: 'hub24',
      slackMemberId: data.devinEmail ? '' : HUB24_SLACK_MEMBER_ID,
      slackMemberIdFallback: HUB24_SLACK_MEMBER_ID,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: [
        { key: 'route', value: '/api/hub24/fee-arrangement' },
        { key: 'service', value: 'customer-hub24-fee-arrangement' },
        { key: 'productCode', value: account.productCode },
        { key: 'productLabel', value: account.productLabel },
        { key: 'feeBasis', value: feeBasis },
        { key: 'frequency', value: frequency },
      ],
      extra: {
        receiptNumber,
        feeArrangementReference,
        clientAccountId,
        clientName: account.clientName,
        feeAmount,
        startDate,
        channel: data.channel,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: 'customer-hub24-fee-arrangement@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for HUB24 fee arrangement error', {
        receiptNumber,
        error: alertError.message,
      });
    });

    throw error;
  }
}

module.exports = {
  submitFeeArrangement,
  resolveFeeSchedule,
  calculateAdviserFeeArrangement,
  roundMoney,
  CLIENT_ACCOUNTS,
  FEE_SCHEDULES,
  FREQUENCY_OPTIONS,
  REMEDIATION_DIRECTIVE,
};
