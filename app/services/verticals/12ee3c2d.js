const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/12ee3c2d/settlements/columns';
const SERVICE = 'merchant-settlements-service';
const SLACK_MEMBER_ID = process.env.AMEX_MERCHANT_SLACK_MEMBER_ID || '';

const MERCHANT = {
  firstName: 'Dana',
  businessName: 'Harbor & Pine Coffee Roasters',
  merchantNumber: '3281947560',
  locations: [
    { id: 'LOC-0101', name: 'Seattle \u2014 Pike Street', merchantNumber: '3281947560' },
    { id: 'LOC-0102', name: 'Portland \u2014 Pearl District', merchantNumber: '3281947578' },
    { id: 'LOC-0103', name: 'Online Store', merchantNumber: '3281947586' },
  ],
};

/**
 * Settlement ledger fields published by the payments ledger API, with display precision.
 */
const LEDGER_FIELDS = {
  settlementDate: { type: 'date' },
  settlementNumber: { type: 'text' },
  payeeMerchantNumber: { type: 'text' },
  payeeLocationId: { type: 'text' },
  totalCharges: { type: 'currency', precision: 2 },
  credits: { type: 'currency', precision: 2 },
  submissionAmount: { type: 'currency', precision: 2 },
  discountAmount: { type: 'currency', precision: 2 },
  feesAndIncentives: { type: 'currency', precision: 2 },
  chargebacks: { type: 'currency', precision: 2 },
  adjustments: { type: 'currency', precision: 2 },
  settlementAmount: { type: 'currency', precision: 2 },
  amountPaidToBank: { type: 'currency', precision: 2 },
  transactionCount: { type: 'count', precision: 0 },
  openingDebitBalance: { type: 'currency', precision: 2 },
};

/**
 * Columns available in the Settlements table "Column Customizations" picker.
 */
const SETTLEMENT_COLUMNS = [
  { key: 'settlement_date', label: 'Settlement Date', ledgerField: 'settlementDate' },
  { key: 'settlement_number', label: 'Settlement Number', ledgerField: 'settlementNumber' },
  { key: 'total_charges', label: 'Total Charges', ledgerField: 'totalCharges' },
  { key: 'credits', label: 'Credits', ledgerField: 'credits' },
  { key: 'submission_amount', label: 'Submission Amount', ledgerField: 'submissionAmount' },
  { key: 'discount_amount', label: 'Discount Amount', ledgerField: 'discountAmount' },
  { key: 'fees_incentives', label: 'Fees & Incentives', ledgerField: 'feesAndIncentives' },
  { key: 'chargebacks', label: 'Chargebacks', ledgerField: 'chargebacks' },
  { key: 'adjustments', label: 'Adjustments', ledgerField: 'adjustments' },
  { key: 'settlement_amount', label: 'Settlement Amount', ledgerField: 'settlementAmount' },
  { key: 'amount_paid_to_bank', label: 'Amount Paid To Bank', ledgerField: 'amountPaidToBank' },
  { key: 'payee_merchant_number', label: 'Payee Merchant Number', ledgerField: 'payeeMerchantNumber' },
  { key: 'payee_location_id', label: 'Payee Location ID', ledgerField: 'payeeLocationId' },
  { key: 'number_of_transactions', label: 'Number of Transactions', ledgerField: 'transactionCount' },
  { key: 'opening_debit_balance', label: 'Opening Debit Balance', ledgerField: 'openingDebitBal' },
];

const DEFAULT_LAYOUT = [
  'settlement_date', 'settlement_number', 'total_charges', 'credits', 'submission_amount', 'discount_amount',
  'fees_incentives', 'chargebacks', 'adjustments', 'settlement_amount', 'amount_paid_to_bank',
];

function round2(n) {
  return Math.round(n * 100) / 100;
}

function buildSettlement(date, number, charges, credits, txns, chargebacks, adjustments, openingDebit, status, locationId = 'LOC-0101') {
  const location = MERCHANT.locations.find((l) => l.id === locationId);
  const submissionAmount = round2(charges - credits);
  const discountAmount = round2(submissionAmount * 0.0265);
  const feesAndIncentives = round2(txns * 0.1);
  const settlementAmount = round2(submissionAmount - discountAmount - feesAndIncentives - chargebacks + adjustments);
  return {
    settlementDate: date, settlementNumber: number, payeeMerchantNumber: location.merchantNumber, payeeLocationId: locationId,
    totalCharges: charges, credits, submissionAmount, discountAmount, feesAndIncentives, chargebacks, adjustments,
    settlementAmount, amountPaidToBank: round2(Math.max(settlementAmount - openingDebit, 0)), transactionCount: txns,
    openingDebitBalance: openingDebit, status,
  };
}

const SETTLEMENTS = [
  buildSettlement('2026-11-04', '60318822', 4128.4, 62.5, 311, 0, 0, 0, 'pending'),
  buildSettlement('2026-11-04', '60318830', 2214.6, 0, 168, 0, 0, 0, 'pending', 'LOC-0103'),
  buildSettlement('2026-11-03', '60318407', 3896.15, 0, 296, 0, 0, 0, 'posted'),
  buildSettlement('2026-11-03', '60318415', 2788.35, 41.2, 214, 0, 0, 0, 'posted', 'LOC-0102'),
  buildSettlement('2026-11-02', '60317986', 5212.75, 118.0, 402, 0, 0, 0, 'posted'),
  buildSettlement('2026-11-02', '60317994', 1906.8, 0, 131, 0, 0, 0, 'posted', 'LOC-0103'),
  buildSettlement('2026-11-01', '60317544', 4987.3, 45.25, 377, 86.4, 0, 0, 'posted'),
  buildSettlement('2026-11-01', '60317552', 2631.15, 0, 198, 0, 0, 0, 'posted', 'LOC-0102'),
  buildSettlement('2026-10-31', '60317120', 3644.9, 0, 271, 0, 0, 0, 'posted'),
  buildSettlement('2026-10-30', '60316698', 3412.55, 22.0, 259, 0, -35.0, 0, 'posted'),
  buildSettlement('2026-10-30', '60316706', 2402.4, 18.5, 182, 0, 0, 0, 'posted', 'LOC-0102'),
  buildSettlement('2026-10-29', '60316271', 3305.2, 0, 248, 142.18, 0, 142.18, 'posted'),
  buildSettlement('2026-10-28', '60315849', 3189.65, 54.75, 240, 0, 0, 0, 'posted'),
  buildSettlement('2026-10-28', '60315857', 1744.9, 0, 119, 0, 0, 0, 'posted', 'LOC-0103'),
  buildSettlement('2026-10-27', '60315402', 2976.4, 0, 223, 0, 12.5, 0, 'posted'),
  buildSettlement('2026-10-26', '60314988', 4411.8, 31.9, 335, 0, 0, 0, 'posted'),
  buildSettlement('2026-10-25', '60314561', 3988.05, 0, 301, 0, 0, 0, 'posted'),
  buildSettlement('2026-10-24', '60314137', 3577.3, 26.4, 268, 0, 0, 0, 'posted'),
];

function adjustment(settlementDate, adjustmentNumber, cardNumber, amount, disputeType, description, amexDate, locationId = 'LOC-0101') {
  const location = MERCHANT.locations.find((l) => l.id === locationId);
  return {
    submittingMerchantNumber: location.merchantNumber, submittingLocationId: locationId, payeeMerchantNumber: location.merchantNumber,
    payeeLocationId: locationId, settlementAmount: amount, settlementDate, cardNumber, adjustmentNumber, submissionAmount: amount,
    totalCharges: 0, credits: Math.abs(amount), discountAmount: 0, feesAndIncentives: 0, disputeType, description, transactionCount: 1, amexDate,
  };
}

const ADJUSTMENTS = [
  adjustment('2026-11-01', '884120', '374355XXXXX1009', -86.4, 'Chargebacks', 'GOODS NOT RECEIVED', '2026-10-30'),
  adjustment('2026-11-01', '884117', '379783XXXXX3008', -24.75, 'Adjustments', 'DEBIT AS CARDMEMBER PAID DIRECT', '2026-10-30', 'LOC-0102'),
  adjustment('2026-10-30', '883961', '372004XXXXX7204', -35.0, 'Adjustments', 'DEBIT FOR MULTIPLE CHARGE', '2026-10-29'),
  adjustment('2026-10-29', '883712', '371105XXXXX1005', -142.18, 'Chargebacks', 'DEBIT AS NO APPROVAL GAINED', '2026-10-27'),
  adjustment('2026-10-28', '883590', '379280XXXXX1004', -18.6, 'Adjustments', 'DEBIT FOR NO REPLY TO INQUIRY', '2026-10-27', 'LOC-0103'),
  adjustment('2026-10-27', '883350', '374501XXXXX4501', 12.5, 'Adjustments', 'CREDIT FOR TERMINAL FEE PRORATION', '2026-10-26'),
  adjustment('2026-10-26', '883204', '376611XXXXX2207', -51.3, 'Adjustments', 'NOT AS DESCRIBED', '2026-10-24', 'LOC-0102'),
];

function dispute(caseNumber, amount, transactionDate, reason, code, caseType, disputeType, expires, daysLeft, cardNumber, locationId, detail, cardMemberName) {
  const location = MERCHANT.locations.find((l) => l.id === locationId);
  return {
    caseNumber, amount: -amount, transactionAmount: amount, transactionDate, reason, code, caseType, disputeType,
    type: disputeType === 'CB' ? 'Chargeback' : 'Inquiry', expires, daysLeft, cardNumber, merchantNumber: location.merchantNumber,
    locationId, chargeReference: `CR${caseNumber.slice(2).toUpperCase()}88`, detail, cardMemberName,
  };
}

const DISPUTES = [
  dispute('D-utgq6', 142.18, '2026-10-12', 'Card not present fraud', 'F29', 'Fraud', 'CB', '2026-11-14', 11, '374355XXXXX5847', 'LOC-0103',
    'Card Member denies participating in a card not present transaction. To request a reversal, provide proof that the Card Member participated in the transaction, such as AVS/CVV match and proof of delivery to the verified address.', 'J. Alvarez'),
  dispute('D-urovq', 86.4, '2026-10-15', 'Goods/Services not received', 'C08', 'Card Member Dispute', 'CB', '2026-11-17', 14, '379783XXXXX3008', 'LOC-0101',
    'Card Member states the order was never received. To request a reversal, provide proof of delivery or proof that the Card Member collected the goods in store.', 'M. Chen'),
  dispute('D-urw24', 58.0, '2026-10-19', 'Credit not presented', 'C02', 'Card Member Dispute', 'CB', '2026-11-20', 17, '379280XXXXX1004', 'LOC-0102',
    'Card Member states a credit was promised but never processed. To request a reversal, provide proof that the credit was issued or that no credit is due.', 'R. Okafor'),
  dispute('D-urw25', 214.5, '2026-10-21', 'Multiple processing', 'P08', 'Processing Error', 'CB', '2026-11-22', 19, '379280XXXXX1004', 'LOC-0101',
    'Card Member states the same charge was processed more than once. To request a reversal, provide itemized receipts showing separate purchases.', 'S. Patel'),
  dispute('D-usk7m', 39.75, '2026-10-24', 'Cancelled recurring billing', 'C28', 'Card Member Dispute', 'CU', '2026-11-25', 22, '376611XXXXX2207', 'LOC-0103',
    'We did not receive your response to our initial inquiry. To request a reversal, provide proof that the subscription was not cancelled before the billing date.', 'L. Novak'),
];

const savedLayouts = new Map();
const disputeResponses = new Map();

function getPortal() {
  return {
    merchant: MERCHANT,
    settlements: SETTLEMENTS,
    adjustments: ADJUSTMENTS,
    disputes: DISPUTES.filter((d) => !disputeResponses.has(d.caseNumber)),
    reviewInProgress: 3 + disputeResponses.size,
    columns: SETTLEMENT_COLUMNS.map(({ key, label }) => ({ key, label })),
    defaultLayout: DEFAULT_LAYOUT,
    savedLayout: savedLayouts.get(MERCHANT.merchantNumber) || null,
  };
}

/**
 * Projects one settlement row onto the requested columns, rounding each value to its ledger precision.
 */
function projectRow(row, columns) {
  return columns.map((col) => {
    const field = LEDGER_FIELDS[col.ledgerField];
    const value = row[col.ledgerField];
    if (field.type === 'currency' || field.type === 'count') {
      return Number(value.toFixed(field.precision));
    }
    return value;
  });
}

function projectSettlements(layout) {
  const columns = layout.map((key) => SETTLEMENT_COLUMNS.find((c) => c.key === key));
  return SETTLEMENTS.map((row) => ({ settlementNumber: row.settlementNumber, status: row.status, values: projectRow(row, columns) }));
}

/**
 * Saves the merchant's Settlements table column layout and returns the re-projected table.
 */
async function saveColumnLayout(data) {
  const startTime = Date.now();
  const preferenceRef = `CP-${uuidv4().slice(0, 8).toUpperCase()}`;
  const requestId = data.requestId || uuidv4();
  const added = data.layout.filter((k) => !DEFAULT_LAYOUT.includes(k));

  logger.info('Saving settlements column layout', {
    preferenceRef, requestId, merchantNumber: MERCHANT.merchantNumber, layout: data.layout, added, service: SERVICE, route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 350 + Math.random() * 300));
    const rows = projectSettlements(data.layout);
    savedLayouts.set(MERCHANT.merchantNumber, data.layout.slice());

    incrementMetric('settlements.columns.save.success', { route: ROUTE });
    recordTiming('settlements.columns.save.latency', Date.now() - startTime, { route: ROUTE });

    return { success: true, preferenceRef, layout: data.layout, rows, savedAt: new Date().toISOString() };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('settlements.columns.save.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('settlements.columns.save.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Settlements column layout save failed', {
      preferenceRef, requestId, error: error.message, errorClass: error.name, layout: data.layout, durationMs: duration, service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, source: 'merchant-settlements', alert_path: 'instant' },
      extra: { preferenceRef, layout: data.layout, added },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/12ee3c2d.js \u2014 projectRow',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: '12ee3c2d',
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      service: SERVICE,
      verticalLabel: 'American Express Merchant \u2014 Settlements Column Customization',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'merchant', value: MERCHANT.merchantNumber },
        { key: 'columns_added', value: added.join(',') || 'none' },
      ],
      extra: { preferenceRef, layout: data.layout, added },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@2026.11.1`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from settlements column layout error', { error: err.message });
    });

    error.preferenceRef = preferenceRef;
    throw error;
  }
}

function respondToDispute(caseNumber, response) {
  if (disputeResponses.has(caseNumber)) return null;
  const dispute = DISPUTES.find((d) => d.caseNumber === caseNumber);
  const record = {
    success: true,
    caseNumber: dispute.caseNumber,
    responseType: response.responseType,
    confirmation: `R-${uuidv4().slice(0, 6).toUpperCase()}`,
    status: 'Review in Progress',
    submittedAt: new Date().toISOString(),
  };
  disputeResponses.set(caseNumber, record);
  return record;
}

module.exports = {
  getPortal,
  saveColumnLayout,
  projectSettlements,
  respondToDispute,
  SETTLEMENT_COLUMNS,
  DEFAULT_LAYOUT,
  DISPUTES,
  LEDGER_FIELDS,
};
