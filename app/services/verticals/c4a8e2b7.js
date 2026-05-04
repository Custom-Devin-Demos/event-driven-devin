const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Wire transfer fee schedule by transfer type
 */
const FEE_SCHEDULE = {
  domestic:      { baseFee: 25.00, percentFee: 0.0005, maxFee: 50.00 },
  international: { baseFee: 45.00, percentFee: 0.0015, maxFee: 150.00 },
  swift:         { baseFee: 35.00, percentFee: 0.0010, maxFee: 100.00 },
};

/**
 * Mock transfer database
 */
const TRANSFERS = [
  { ref: 'BNY-2026-00481', account: '8290-4471-0033', originator: 'Vanguard Institutional', beneficiary: 'State Street Global', amount: 2750000.00, currency: 'USD', type: 'domestic', status: 'pending', routing: { bankCode: '021000018', swiftCode: 'IRVTUS3N', routingNumber: '021000018' } },
  { ref: 'BNY-2026-00482', account: '8290-4471-0033', originator: 'Vanguard Institutional', beneficiary: 'HSBC Holdings PLC', amount: 5200000.00, currency: 'USD', type: 'international', status: 'processing', routing: { bankCode: '021000018', swiftCode: 'IRVTUS3N', routingNumber: '021000018' } },
  { ref: 'BNY-2026-00483', account: '6150-8823-0017', originator: 'BlackRock Fund Advisors', beneficiary: 'JP Morgan Securities', amount: 1450000.00, currency: 'USD', type: 'swift', status: 'completed', routing: { bankCode: '021000018', swiftCode: 'IRVTUS3N', routingNumber: '021000018' } },
  { ref: 'BNY-2026-00484', account: '6150-8823-0017', originator: 'BlackRock Fund Advisors', beneficiary: 'UBS AG Zurich', amount: 8900000.00, currency: 'EUR', type: 'international', status: 'pending', routing: { bankCode: '021000018', swiftCode: 'IRVTUS3N', routingNumber: '021000018' } },
];

/**
 * Recent wire activity for display
 */
const RECENT_WIRES = [
  { date: '2026-04-28', ref: 'BNY-2026-00481', beneficiary: 'State Street Global', amount: 2750000.00, status: 'Pending' },
  { date: '2026-04-25', ref: 'BNY-2026-00480', beneficiary: 'Northern Trust Corp', amount: 1200000.00, status: 'Completed' },
  { date: '2026-04-22', ref: 'BNY-2026-00479', beneficiary: 'Citibank NA', amount: 4500000.00, status: 'Completed' },
  { date: '2026-04-18', ref: 'BNY-2026-00478', beneficiary: 'Deutsche Bank AG', amount: 3100000.00, status: 'Completed' },
];

/**
 * Look up a transfer record by reference number and account.
 * Returns the raw transfer data from the database.
 */
function findTransfer(query) {
  const transfer = TRANSFERS.find(
    (t) => t.ref === query.transferRef || t.account === query.accountNumber
  );
  if (!transfer) return null;
  return {
    details: {
      ref: transfer.ref,
      originator: transfer.originator,
      beneficiary: transfer.beneficiary,
      amount: transfer.amount,
      currency: transfer.currency,
      type: transfer.type,
      status: transfer.status,
    },
    routing: {
      bankCode: transfer.routing.bankCode,
      swiftCode: transfer.routing.swiftCode,
      routingNumber: transfer.routing.routingNumber,
    },
  };
}

/**
 * Resolve routing and compliance details for the transfer.
 * Returns the validated routing info and compliance flags.
 */
function resolveRoutingDetails(transferData, requestedType) {
  const wireType = requestedType || transferData.details.type;
  const schedule = FEE_SCHEDULE[wireType];
  if (!schedule) return null;

  return {
    wireType,
    routingInfo: [transferData.routing.bankCode, transferData.routing.swiftCode, transferData.routing.routingNumber],
  };
}

/**
 * Calculate wire transfer fees from transfer data and routing details.
 * Applies the fee schedule based on transfer amount and wire type.
 */
function calculateTransferFees(transferData, routingDetails) {
  const amount = transferData.details.amount;
  const schedule = FEE_SCHEDULE[routingDetails.routing.wireType];
  const percentComponent = amount * schedule.percentFee;
  const totalFee = Math.min(schedule.baseFee + percentComponent, schedule.maxFee);

  return {
    amount,
    baseFee: schedule.baseFee.toFixed(2),
    percentFee: percentComponent.toFixed(2),
    totalFee: totalFee.toFixed(2),
    netAmount: (amount - totalFee).toFixed(2),
    estimatedSettlement: calculateSettlementDate(routingDetails),
  };
}

/**
 * Estimate settlement date based on wire type.
 */
function calculateSettlementDate(routingDetails) {
  const daysMap = { domestic: 1, international: 3, swift: 2 };
  const days = daysMap[routingDetails.wireType] || 2;
  const settle = new Date();
  settle.setDate(settle.getDate() + days);
  return settle.toISOString().split('T')[0];
}

/**
 * Process a wire transfer status lookup.
 */
async function processTransferLookup(data) {
  const startTime = Date.now();
  const lookupId = uuidv4();

  logger.info('Processing wire transfer lookup', {
    lookupId,
    transferRef: data.transferRef,
    accountNumber: data.accountNumber,
    wireType: data.wireType,
    service: 'c4a8e2b7-api',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const transferData = findTransfer(data);
    if (!transferData) {
      const err = new Error('Transfer not found. Please verify your reference number and account.');
      err.name = 'TransferNotFoundError';
      err.code = 'TRANSFER_NOT_FOUND';
      throw err;
    }

    const routingDetails = resolveRoutingDetails(transferData, data.wireType);
    const fees = calculateTransferFees(transferData, routingDetails);

    const duration = Date.now() - startTime;

    incrementMetric('wire.lookup.success', {
      route: '/api/c4a8e2b7/transfer',
      wireType: data.wireType,
    });
    recordTiming('wire.lookup.latency', duration, {
      route: '/api/c4a8e2b7/transfer',
    });

    return {
      success: true,
      lookupId,
      transfer: transferData.details,
      fees,
      recentWires: RECENT_WIRES,
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('wire.lookup.failure', {
      route: '/api/c4a8e2b7/transfer',
      errorClass: error.name,
      wireType: data.wireType,
    });
    recordTiming('wire.lookup.latency', duration, {
      route: '/api/c4a8e2b7/transfer',
      error: 'true',
    });

    logger.error('Wire transfer lookup failed', {
      lookupId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      transferRef: data.transferRef,
      accountNumber: data.accountNumber,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/c4a8e2b7/transfer',
        service: 'c4a8e2b7-api',
        wireType: data.wireType,
      },
      extra: {
        lookupId,
        transferRef: data.transferRef,
        accountNumber: data.accountNumber,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/c4a8e2b7.js — processTransferLookup',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      slackMemberId: 'U08S7AVJ478',
      service: 'c4a8e2b7-api',
      verticalLabel: 'Wire Transfer Lookup',
      customer: 'c4a8e2b7',
      tags: [
        { key: 'route', value: '/api/c4a8e2b7/transfer' },
        { key: 'service', value: 'c4a8e2b7-api' },
        { key: 'wireType', value: data.wireType },
      ],
      extra: { lookupId, transferRef: data.transferRef, accountNumber: data.accountNumber },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'c4a8e2b7@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from wire transfer lookup error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processTransferLookup, TRANSFERS, RECENT_WIRES };
