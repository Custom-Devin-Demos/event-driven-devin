const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Merchants onboarded to the FIS Payments One authorization switch. The MCC and
 * acceptance channel drive which interchange program the transaction settles at.
 */
const MERCHANTS = [
  { id: 'MID-4471902', name: 'Northwind Outfitters', mcc: '5651', channel: 'card_not_present', network: 'visa', country: 'GB' },
  { id: 'MID-2280455', name: 'Riverside Grocers', mcc: '5411', channel: 'card_present', network: 'visa', country: 'US' },
  { id: 'MID-9013774', name: 'Atlas Freight Systems', mcc: '4214', channel: 'card_not_present', network: 'mastercard', country: 'US' },
  { id: 'MID-6624108', name: 'Lakeshore Dental Group', mcc: '8021', channel: 'card_present', network: 'mastercard', country: 'US' },
];

/**
 * Registered interchange and network fee schedule. Every fee code assessed on an
 * authorization must resolve to an entry here so the settlement ledger can
 * compute the amount owed.
 */
const FEE_SCHEDULE = [
  { code: 'IC-VISA-CPS-RETAIL', name: 'Visa CPS/Retail', basisPoints: 145, fixedCents: 10 },
  { code: 'IC-VISA-CNP-STD', name: 'Visa CNP Standard', basisPoints: 195, fixedCents: 10 },
  { code: 'IC-MC-MERIT-III', name: 'Mastercard Merit III', basisPoints: 158, fixedCents: 10 },
  { code: 'IC-MC-CNP-STD', name: 'Mastercard CNP Standard', basisPoints: 189, fixedCents: 10 },
  { code: 'NET-VISA-APF', name: 'Visa Acquirer Processing Fee', basisPoints: 0, fixedCents: 2 },
  { code: 'NET-MC-NABU', name: 'Mastercard NABU Fee', basisPoints: 0, fixedCents: 2 },
];

/**
 * Interchange program per network and acceptance channel, used to resolve the
 * base interchange line before network assessments are layered on.
 */
const INTERCHANGE_PROGRAM = {
  visa: { card_present: 'IC-VISA-CPS-RETAIL', card_not_present: 'IC-VISA-CNP-STD' },
  mastercard: { card_present: 'IC-MC-MERIT-III', card_not_present: 'IC-MC-CNP-STD' },
};

/**
 * Per-network acquirer assessment applied to every authorization regardless of
 * channel or geography.
 */
const NETWORK_ASSESSMENT = {
  visa: 'NET-VISA-APF',
  mastercard: 'NET-MC-NABU',
};

/**
 * Settlement rails available to the acquirer, driving the funding window
 * reported back to the merchant.
 */
const SETTLEMENT_RAILS = {
  US: { rail: 'fis-nyce-settlement', label: 'NYCE Same-Day Settlement', fundingDays: 1 },
  GB: { rail: 'fis-uk-faster-payments', label: 'UK Faster Payments', fundingDays: 1 },
  EU: { rail: 'fis-sepa-settlement', label: 'SEPA Credit Transfer', fundingDays: 2 },
};

/**
 * Cross-border assessments that are force-attached to any card-not-present
 * authorization where the issuer country differs from the merchant country.
 * The 2026 international service assessment must be assessed for the
 * transaction to clear, but its fee code is not yet registered in FEE_SCHEDULE.
 */
const CROSS_BORDER_ASSESSMENTS = [
  { code: 'NET-ISA-CB-2026', reason: 'International Service Assessment (cross-border CNP)' },
];

/**
 * Returns the authorization risk decision band for a transaction score.
 */
function getRiskBand(score) {
  if (score >= 90) return { band: 'decline', label: 'High risk \u2014 decline' };
  if (score >= 60) return { band: 'review', label: 'Elevated risk \u2014 step-up review' };
  return { band: 'approve', label: 'Low risk \u2014 auto approve' };
}

/**
 * Resolves the base interchange fee line for the merchant's network and
 * acceptance channel, plus the settlement rail used to fund the merchant.
 */
function resolveInterchange(merchant, issuerCountry) {
  const programs = INTERCHANGE_PROGRAM[merchant.network];
  if (!programs) {
    throw Object.assign(new Error(`Unsupported card network: ${merchant.network}`), { code: 'INVALID_NETWORK' });
  }
  const programCode = programs[merchant.channel];
  if (!programCode) {
    throw Object.assign(new Error(`Unsupported acceptance channel: ${merchant.channel}`), { code: 'INVALID_CHANNEL' });
  }
  const rail = SETTLEMENT_RAILS[merchant.country] || SETTLEMENT_RAILS.US;
  return {
    feeLines: [
      { code: programCode, source: 'interchange' },
      { code: NETWORK_ASSESSMENT[merchant.network], source: 'assessment' },
    ],
    rail: rail.rail,
    railLabel: rail.label,
    fundingDays: rail.fundingDays,
    crossBorder: issuerCountry !== merchant.country,
  };
}

/**
 * Layers the mandatory cross-border assessments onto the resolved fee lines for
 * card-not-present authorizations settled across borders.
 */
function applyCrossBorderAssessments(feeLines, merchant, issuerCountry) {
  const isCrossBorderCnp = merchant.channel === 'card_not_present' && issuerCountry !== merchant.country;
  if (!isCrossBorderCnp) return feeLines;
  const assessments = CROSS_BORDER_ASSESSMENTS.map((fee) => ({ code: fee.code, source: 'cross_border' }));
  return [...feeLines, ...assessments];
}

/**
 * Builds the settlement ledger returned to the merchant \u2014 one line per assessed
 * fee, resolving each fee code to its schedule definition and rate.
 * BUG: NET-ISA-CB-2026 is not in FEE_SCHEDULE, so feeDef.basisPoints crashes.
 */
function buildSettlementLedger(feeLines, amountCents) {
  return feeLines.map((line) => {
    const feeDef = FEE_SCHEDULE.find((f) => f.code === line.code);
    const amount = (amountCents * feeDef.basisPoints) / 10000 + feeDef.fixedCents;
    return {
      code: line.code,
      name: feeDef.name,
      basisPoints: feeDef.basisPoints,
      fixedCents: feeDef.fixedCents,
      source: line.source,
      amountCents: Math.round(amount),
    };
  });
}

/**
 * Authorizes a card payment through the FIS Payments One switch and prices its
 * settlement ledger.
 */
async function authorizePayment(paymentData) {
  const startTime = Date.now();
  const authId = uuidv4();

  logger.info('Authorizing FIS card payment', {
    authId,
    merchantId: paymentData.merchantId,
    amount: paymentData.amount,
    issuerCountry: paymentData.issuerCountry,
    service: 'fis-payments-one',
    route: '/api/2ef89b23/authorize',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 90 + Math.random() * 140));

    const merchant = MERCHANTS.find((m) => m.id === paymentData.merchantId) || MERCHANTS[0];
    const amount = Number(paymentData.amount) || 0;
    const amountCents = Math.round(amount * 100);
    const issuerCountry = paymentData.issuerCountry || 'US';
    const riskScore = Number(paymentData.riskScore) || 12;
    const risk = getRiskBand(riskScore);

    const interchange = resolveInterchange(merchant, issuerCountry);
    const feeLines = applyCrossBorderAssessments(interchange.feeLines, merchant, issuerCountry);
    const ledger = buildSettlementLedger(feeLines, amountCents);

    const totalFees = Number((ledger.reduce((sum, line) => sum + line.amountCents, 0) / 100).toFixed(2));
    const duration = Date.now() - startTime;

    incrementMetric('authorization.success', {
      route: '/api/2ef89b23/authorize',
      source: 'fis-payments-one',
    });
    recordTiming('authorization.latency', duration, {
      route: '/api/2ef89b23/authorize',
    });

    return {
      success: true,
      authId,
      approvalCode: authId.slice(0, 6).toUpperCase(),
      merchantId: merchant.id,
      merchantName: merchant.name,
      network: merchant.network,
      amount: Number(amount.toFixed(2)),
      issuerCountry,
      crossBorder: interchange.crossBorder,
      riskBand: risk.band,
      riskLabel: risk.label,
      rail: interchange.rail,
      railLabel: interchange.railLabel,
      fundingDays: interchange.fundingDays,
      totalFees,
      netSettlement: Number((amount - totalFees).toFixed(2)),
      ledger,
      status: 'approved',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('authorization.failure', {
      route: '/api/2ef89b23/authorize',
      errorClass: error.name,
      source: 'fis-payments-one',
    });
    recordTiming('authorization.latency', duration, {
      route: '/api/2ef89b23/authorize',
      error: 'true',
    });

    logger.error('FIS card payment authorization failed', {
      authId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      merchantId: paymentData.merchantId,
      issuerCountry: paymentData.issuerCountry,
      service: 'fis-payments-one',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/2ef89b23/authorize',
        service: 'fis-payments-one',
        source: 'fis-payments-one',
      },
      extra: {
        authId,
        merchantId: paymentData.merchantId,
        amount: paymentData.amount,
        issuerCountry: paymentData.issuerCountry,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/2ef89b23.js \u2014 buildSettlementLedger',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: '2ef89b23',
      devinUserId: paymentData.devinUserId,
      devinEmail: paymentData.devinEmail,
      devinOrgId: paymentData.devinOrgId,
      service: 'fis-payments-one',
      verticalLabel: 'FIS \u2014 Payments One Authorization & Settlement',
      tags: [
        { key: 'route', value: '/api/2ef89b23/authorize' },
        { key: 'service', value: 'fis-payments-one' },
        { key: 'category', value: 'payment-authorization' },
        { key: 'data_class', value: 'financial' },
      ],
      extra: {
        authId,
        merchantId: paymentData.merchantId,
        amount: paymentData.amount,
        issuerCountry: paymentData.issuerCountry,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'fis-payments-one@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from FIS authorization error', { error: err.message });
    });

    throw error;
  }
}

module.exports = {
  authorizePayment,
  buildSettlementLedger,
  applyCrossBorderAssessments,
  resolveInterchange,
  getRiskBand,
  MERCHANTS,
  FEE_SCHEDULE,
  SETTLEMENT_RAILS,
};
