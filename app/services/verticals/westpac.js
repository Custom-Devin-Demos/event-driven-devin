const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const CARDS = {
  'WBC-CC-4417-2280': {
    cardAccountNumber: 'WBC-CC-4417-2280',
    cardholderName: 'Lachlan Pemberton',
    productCode: 'westpac_altitude_black_mastercard',
    productLabel: 'Altitude Black Mastercard',
    maskedCardNumber: '5163 •••• •••• 8042',
    creditLimit: 45000,
    availableCredit: 31284.55,
    accountOpenDate: '2024-06-11',
    brand: 'Westpac',
    issuer: 'Westpac Banking Corporation',
  },
  'WBC-CC-9902-1147': {
    cardAccountNumber: 'WBC-CC-9902-1147',
    cardholderName: 'Melina Farrugia',
    productCode: 'westpac_low_rate_card',
    productLabel: 'Low Rate Card',
    maskedCardNumber: '4564 •••• •••• 3317',
    creditLimit: 12000,
    availableCredit: 8420.10,
    accountOpenDate: '2023-02-27',
    brand: 'Westpac',
    issuer: 'Westpac Banking Corporation',
  },
  'WBC-DB-2213-7788': {
    cardAccountNumber: 'WBC-DB-2213-7788',
    cardholderName: 'Tomas Nowak',
    productCode: 'westpac_choice_debit',
    productLabel: 'Choice Debit Mastercard',
    maskedCardNumber: '4176 •••• •••• 5590',
    creditLimit: 0,
    availableCredit: 4210.65,
    accountOpenDate: '2022-09-05',
    brand: 'Westpac',
    issuer: 'Westpac Banking Corporation',
  },
};

const DISPUTE_RULES = {
  // westpac_altitude_black_mastercard moved to the FY26 Mastercard scheme-rules registry; registration pending
  westpac_low_rate_card: {
    label: 'Low Rate Card',
    scheme: 'Visa',
    chargebackWindowDays: 120,
    maxDisputeAmount: 10000,
    provisionalCreditEligible: true,
    provisionalCreditCapAmount: 2000,
    investigationDays: 10,
    disputeQueue: 'cards-visa-daily',
  },
  westpac_choice_debit: {
    label: 'Choice Debit Mastercard',
    scheme: 'Mastercard',
    chargebackWindowDays: 90,
    maxDisputeAmount: 5000,
    provisionalCreditEligible: false,
    provisionalCreditCapAmount: 0,
    investigationDays: 15,
    disputeQueue: 'debit-mastercard-daily',
  },
};

const WESTPAC_SLACK_MEMBER_ID = process.env.WESTPAC_SLACK_MEMBER_ID || '';
const SENTRY_ISSUE_QUERY = 'is:unresolved chargebackWindowDays';

const REMEDIATION_DIRECTIVE = `Repository: COG-GTM/event-driven-devin. Scope: only the Westpac card transaction dispute lodgement failure below. This repository contains many independent customer demos, each with its own intentional defect and Sentry issue. Investigate only POST /api/westpac/dispute and do not modify any other vertical. Explicitly exclude NRMA, CFS, QBE, HCF, Suncorp, Insignia, HUB24, Morgan Stanley, and every unrelated vertical. The failing surface is app/public/verticals/westpac.html at GET /westpac; its "Lodge dispute" action posts to POST /api/westpac/dispute in app/routes/verticals/westpac.js. The dispute pipeline is submitDispute -> calculateDisputeOutcome -> resolveDisputeRules in app/services/verticals/westpac.js. Start at resolveDisputeRules: it looks up DISPUTE_RULES by card product code, and westpac_altitude_black_mastercard is intentionally absent because it moved to the FY26 Mastercard scheme-rules registry, so the lookup returns undefined and calculateDisputeOutcome dereferences chargebackWindowDays. Fix this by registering the missing westpac_altitude_black_mastercard dispute-rules entry; do not patch around the crash or alter unrelated verticals. Verify with node app/server.js, curl against POST /api/westpac/dispute, and npm run lint. Visual Fix Verification is mandatory: open /westpac in a real browser, submit an accepted dispute after the fix, and capture evidence showing the form, Lodge dispute action, and accepted receipt.`;

function resolveDisputeRules(card) {
  return DISPUTE_RULES[card.productCode];
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function validationError(message) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = 'INVALID_DISPUTE_REQUEST';
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

function makeDisputeReference() {
  const digits = uuidv4().replace(/\D/g, '').slice(0, 10).padEnd(10, '0');
  return `WBC-DSP-${digits}`;
}

function makeReceiptNumber() {
  const digits = uuidv4().replace(/\D/g, '').slice(0, 8).padEnd(8, '0');
  return `WBC-${digits}`;
}

function calculateDisputeOutcome(card, dispute) {
  const rules = resolveDisputeRules(card);
  const chargebackWindowDays = rules.chargebackWindowDays;
  const transactionTimestamp = new Date(`${dispute.transactionDate}T00:00:00.000Z`).getTime();
  const daysSinceTransaction = Math.max(
    0,
    Math.floor((Date.now() - transactionTimestamp) / 86400000),
  );
  const withinChargebackWindow = daysSinceTransaction <= chargebackWindowDays;
  const provisionalCreditAmount = rules.provisionalCreditEligible
    ? roundMoney(Math.min(dispute.transactionAmount, rules.provisionalCreditCapAmount))
    : 0;
  const exceedsDisputeCap = dispute.transactionAmount > rules.maxDisputeAmount;

  return {
    rules,
    chargebackWindowDays,
    daysSinceTransaction,
    withinChargebackWindow,
    provisionalCreditAmount,
    exceedsDisputeCap,
    estimatedOutcomeDate: addBusinessishDays(dispute.transactionDate, rules.investigationDays),
    scheme: rules.scheme,
    disputeQueue: rules.disputeQueue,
    appliedAtText: `Dispute lodged for investigation from ${dispute.transactionDate}`,
  };
}

async function submitDispute(data) {
  const startTime = Date.now();
  const disputeReference = makeDisputeReference();
  const receiptNumber = makeReceiptNumber();
  const cardAccountNumber = data.cardAccountNumber;
  const card = CARDS[cardAccountNumber];
  const disputeReason = data.disputeReason;
  const merchantName = data.merchantName;
  const transactionDate = data.transactionDate;
  const transactionAmount = data.transactionAmount;
  const cardPresent = data.cardPresent;
  const contactedMerchant = data.contactedMerchant;
  const cardLostOrStolen = data.cardLostOrStolen;
  const contactNumber = data.contactNumber;
  const description = data.description;
  const declaration = data.declaration;

  if (!cardAccountNumber || !String(cardAccountNumber).trim() || !card) {
    throw validationError(`Unknown card account number: ${cardAccountNumber || '(none)'}`);
  }
  if (![
    'unauthorised',
    'duplicate',
    'goods-not-received',
    'incorrect-amount',
    'subscription-not-cancelled',
  ].includes(disputeReason)) {
    throw validationError('Dispute reason is invalid');
  }
  if (typeof merchantName !== 'string' || !merchantName.trim()) {
    throw validationError('Merchant name is required');
  }
  if (!isCalendarDate(transactionDate)) {
    throw validationError('Transaction date must be a valid YYYY-MM-DD calendar date');
  }
  if (!Number.isFinite(transactionAmount) || transactionAmount <= 0) {
    throw validationError('Transaction amount must be a positive number');
  }
  if (typeof description !== 'string' || !description.trim()) {
    throw validationError('Dispute description is required');
  }
  if (typeof contactNumber !== 'string' || !contactNumber.trim()) {
    throw validationError('Contact number is required');
  }
  if (declaration !== true) {
    throw validationError('Declaration is required before a dispute can be lodged');
  }

  logger.info('Submitting Westpac card dispute', {
    disputeReference,
    receiptNumber,
    cardAccountNumber,
    disputeReason,
    merchantName,
    transactionDate,
    transactionAmount,
    cardPresent,
    contactedMerchant,
    cardLostOrStolen,
    contactNumber,
    description,
    channel: data.channel,
    service: 'customer-westpac-disputes',
    route: '/api/westpac/dispute',
  });

  try {
    const outcome = calculateDisputeOutcome(card, {
      transactionDate,
      transactionAmount,
    });
    const submittedAt = new Date().toISOString();
    const duration = Date.now() - startTime;

    incrementMetric('westpac_dispute.success', {
      route: '/api/westpac/dispute',
      productCode: card.productCode,
      disputeReason,
    });
    recordTiming('westpac_dispute.latency', duration, {
      route: '/api/westpac/dispute',
    });

    return {
      success: true,
      status: 'accepted',
      disputeReference,
      receiptNumber,
      cardAccountNumber,
      cardholderName: card.cardholderName,
      productLabel: card.productLabel,
      maskedCardNumber: card.maskedCardNumber,
      creditLimit: card.creditLimit,
      availableCredit: card.availableCredit,
      accountOpenDate: card.accountOpenDate,
      brand: card.brand,
      issuer: card.issuer,
      disputeReason,
      merchantName,
      transactionDate,
      transactionAmount,
      cardPresent,
      contactedMerchant,
      cardLostOrStolen,
      contactNumber,
      description,
      chargebackWindowDays: outcome.chargebackWindowDays,
      daysSinceTransaction: outcome.daysSinceTransaction,
      withinChargebackWindow: outcome.withinChargebackWindow,
      provisionalCreditAmount: outcome.provisionalCreditAmount,
      exceedsDisputeCap: outcome.exceedsDisputeCap,
      estimatedOutcomeDate: outcome.estimatedOutcomeDate,
      investigationDays: outcome.rules.investigationDays,
      scheme: outcome.scheme,
      disputeQueue: outcome.disputeQueue,
      appliedAtText: outcome.appliedAtText,
      submittedAt,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    if (error.name === 'ValidationError') {
      incrementMetric('westpac_dispute.failure', {
        route: '/api/westpac/dispute',
        errorClass: error.name,
        productCode: card.productCode,
        disputeReason,
      });
      recordTiming('westpac_dispute.latency', duration, {
        route: '/api/westpac/dispute',
        error: 'true',
      });
      throw error;
    }

    incrementMetric('westpac_dispute.failure', {
      route: '/api/westpac/dispute',
      errorClass: error.name,
      productCode: card.productCode,
      disputeReason,
    });
    recordTiming('westpac_dispute.latency', duration, {
      route: '/api/westpac/dispute',
      error: 'true',
    });

    logger.error('Westpac card dispute failed', {
      disputeReference,
      receiptNumber,
      cardAccountNumber,
      disputeReason,
      merchantName,
      transactionDate,
      transactionAmount,
      cardPresent,
      contactedMerchant,
      cardLostOrStolen,
      contactNumber,
      description,
      channel: data.channel,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: 'customer-westpac-disputes',
      route: '/api/westpac/dispute',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/westpac/dispute',
        service: 'customer-westpac-disputes',
        productCode: card.productCode,
        productLabel: card.productLabel,
        disputeReason,
      },
      extra: {
        disputeReference,
        receiptNumber,
        cardAccountNumber,
        cardholderName: card.cardholderName,
        merchantName,
        transactionDate,
        transactionAmount,
        cardPresent,
        contactedMerchant,
        cardLostOrStolen,
        contactNumber,
        description,
        channel: data.channel,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=${encodeURIComponent(SENTRY_ISSUE_QUERY)}`,
      culprit: 'app/services/verticals/westpac.js — calculateDisputeOutcome',
      errorType: error.name || 'Error',
      errorValue: error.message,
      service: 'customer-westpac-disputes',
      verticalLabel: 'Westpac — Card Transaction Dispute',
      customer: 'westpac',
      slackMemberId: data.devinEmail ? '' : WESTPAC_SLACK_MEMBER_ID,
      slackMemberIdFallback: WESTPAC_SLACK_MEMBER_ID,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: [
        { key: 'route', value: '/api/westpac/dispute' },
        { key: 'service', value: 'customer-westpac-disputes' },
        { key: 'productCode', value: card.productCode },
        { key: 'productLabel', value: card.productLabel },
        { key: 'disputeReason', value: disputeReason },
      ],
      extra: {
        disputeReference,
        receiptNumber,
        cardAccountNumber,
        cardholderName: card.cardholderName,
        merchantName,
        transactionDate,
        transactionAmount,
        cardPresent,
        contactedMerchant,
        cardLostOrStolen,
        contactNumber,
        description,
        channel: data.channel,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: 'customer-westpac-disputes@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for Westpac dispute error', {
        disputeReference,
        error: alertError.message,
      });
    });

    throw error;
  }
}

module.exports = {
  submitDispute,
  resolveDisputeRules,
  calculateDisputeOutcome,
  roundMoney,
  isCalendarDate,
  CARDS,
  DISPUTE_RULES,
  REMEDIATION_DIRECTIVE,
};
