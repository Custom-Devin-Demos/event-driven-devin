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

function buildSettlement(date, number, charges, credits, txns, chargebacks, adjustments, openingDebit, status) {
  const submissionAmount = round2(charges - credits);
  const discountAmount = round2(submissionAmount * 0.0265);
  const feesAndIncentives = round2(txns * 0.1);
  const settlementAmount = round2(submissionAmount - discountAmount - feesAndIncentives - chargebacks + adjustments);
  return {
    settlementDate: date, settlementNumber: number, payeeMerchantNumber: MERCHANT.merchantNumber, payeeLocationId: 'LOC-0101',
    totalCharges: charges, credits, submissionAmount, discountAmount, feesAndIncentives, chargebacks, adjustments,
    settlementAmount, amountPaidToBank: round2(Math.max(settlementAmount - openingDebit, 0)), transactionCount: txns,
    openingDebitBalance: openingDebit, status,
  };
}

const SETTLEMENTS = [
  buildSettlement('2026-11-04', '60318822', 4128.4, 62.5, 311, 0, 0, 0, 'pending'),
  buildSettlement('2026-11-03', '60318407', 3896.15, 0, 296, 0, 0, 0, 'pending'),
  buildSettlement('2026-11-02', '60317986', 5212.75, 118.0, 402, 0, 0, 0, 'posted'),
  buildSettlement('2026-11-01', '60317544', 4987.3, 45.25, 377, 86.4, 0, 0, 'posted'),
  buildSettlement('2026-10-31', '60317120', 3644.9, 0, 271, 0, 0, 0, 'posted'),
  buildSettlement('2026-10-30', '60316698', 3412.55, 22.0, 259, 0, -35.0, 0, 'posted'),
  buildSettlement('2026-10-29', '60316271', 3305.2, 0, 248, 142.18, 0, 142.18, 'posted'),
  buildSettlement('2026-10-28', '60315849', 3189.65, 54.75, 240, 0, 0, 0, 'posted'),
  buildSettlement('2026-10-27', '60315402', 2976.4, 0, 223, 0, 12.5, 0, 'posted'),
  buildSettlement('2026-10-26', '60314988', 4411.8, 31.9, 335, 0, 0, 0, 'posted'),
];

const ADJUSTMENTS = [
  { settlementDate: '2026-11-01', adjustmentNumber: '884120', cardNumber: '\u2022\u2022\u2022\u2022 31009', settlementAmount: -86.4, disputeType: 'Chargeback', description: 'Chargeback \u2014 goods/services not received (C08)', amexDate: '2026-10-30' },
  { settlementDate: '2026-10-30', adjustmentNumber: '883961', cardNumber: '\u2022\u2022\u2022\u2022 72004', settlementAmount: -35.0, disputeType: 'Adjustment', description: 'Duplicate submission reversal', amexDate: '2026-10-29' },
  { settlementDate: '2026-10-29', adjustmentNumber: '883712', cardNumber: '\u2022\u2022\u2022\u2022 11005', settlementAmount: -142.18, disputeType: 'Chargeback', description: 'Chargeback \u2014 no card member authorization (F29)', amexDate: '2026-10-27' },
  { settlementDate: '2026-10-27', adjustmentNumber: '883350', cardNumber: '\u2022\u2022\u2022\u2022 45001', settlementAmount: 12.5, disputeType: 'Adjustment', description: 'Fee credit \u2014 terminal rental proration', amexDate: '2026-10-26' },
];

const DISPUTES = [
  { caseNumber: 'D-48217', amount: -142.18, transactionAmount: 142.18, transactionDate: '2026-10-12', reason: 'No Card Member Authorization', code: 'F29', caseType: 'Fraud', disputeType: 'CB', type: 'Chargeback', expires: '2026-11-14', daysLeft: 11 },
  { caseNumber: 'D-48233', amount: -86.4, transactionAmount: 86.4, transactionDate: '2026-10-15', reason: 'Goods/Services Not Received', code: 'C08', caseType: 'Card Member Dispute', disputeType: 'CB', type: 'Chargeback', expires: '2026-11-17', daysLeft: 14 },
  { caseNumber: 'D-48251', amount: -58.0, transactionAmount: 58.0, transactionDate: '2026-10-19', reason: 'Credit Not Presented', code: 'C02', caseType: 'Card Member Dispute', disputeType: 'CB', type: 'Chargeback', expires: '2026-11-20', daysLeft: 17 },
  { caseNumber: 'D-48266', amount: -214.5, transactionAmount: 214.5, transactionDate: '2026-10-21', reason: 'Multiple Processing', code: 'P08', caseType: 'Processing Error', disputeType: 'CB', type: 'Chargeback', expires: '2026-11-22', daysLeft: 19 },
  { caseNumber: 'D-48279', amount: -39.75, transactionAmount: 39.75, transactionDate: '2026-10-24', reason: 'Cancelled Recurring Billing', code: 'C28', caseType: 'Card Member Dispute', disputeType: 'CU', type: 'Inquiry', expires: '2026-11-25', daysLeft: 22 },
];

const savedLayouts = new Map();

function getPortal() {
  return {
    merchant: MERCHANT,
    settlements: SETTLEMENTS,
    adjustments: ADJUSTMENTS,
    disputes: DISPUTES,
    columns: SETTLEMENT_COLUMNS.map(({ key, label }) => ({ key, label })),
    defaultLayout: DEFAULT_LAYOUT,
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
  const dispute = DISPUTES.find((d) => d.caseNumber === caseNumber);
  return {
    success: true,
    caseNumber: dispute.caseNumber,
    responseType: response.responseType,
    confirmation: `R-${uuidv4().slice(0, 6).toUpperCase()}`,
    status: 'Review in Progress',
    submittedAt: new Date().toISOString(),
  };
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
