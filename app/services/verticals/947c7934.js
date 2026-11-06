/* global setImmediate */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.RHO_SLACK_MEMBER_ID || '';

const SERVICE = 'customer-947c7934-move-funds';
const ROUTE = '/api/947c7934/payments';

const LATENCY_SLO = { budgetMs: 3000 };
const SCREENING_POLICY = { perPayeeMinMs: 450, perPayeeMaxMs: 550 };

const ACCOUNT = {
  id: 'op-1234',
  name: 'Operating',
  type: 'Checking',
  mask: '1234',
};

const ACCOUNTS = [
  ACCOUNT,
  { id: 'pay-5678', name: 'Payroll Checking', type: 'Checking', mask: '5678' },
  { id: 'trs-9021', name: 'Treasury', type: 'Treasury', mask: '9021' },
];

const BALANCES = {
  availableCents: 492690418,
  availableChangeCents: 245811000,
  currentCents: 641266319,
  currentChangeCents: 250000000,
  pendingOutCents: 148575901,
  pendingInCents: 17500000,
};

const TRANSACTIONS = [
  {
    id: 'txn-0131-01',
    createdDate: '2026-01-31T16:45:00.000Z',
    amountCents: 250000000,
    sender: { name: 'Follow-On Fund', accountType: 'Checking', mask: '6120' },
    recipient: { name: 'Operating', accountType: 'Checking', mask: '1234' },
    type: 'Wire-US',
    status: 'Settled',
  },
  {
    id: 'txn-0131-02',
    createdDate: '2026-01-31T15:20:00.000Z',
    amountCents: -4189000,
    sender: { name: 'Operating', accountType: 'Checking', mask: '1234' },
    recipient: { name: 'Definitely AGI Pty Ltd', accountType: 'Checking', mask: '4402' },
    type: 'Wire-INTL',
    status: 'Pending',
  },
  {
    id: 'txn-0130-01',
    createdDate: '2026-01-30T18:10:00.000Z',
    amountCents: -69041255,
    sender: { name: 'Operating', accountType: 'Checking', mask: '1234' },
    recipient: { name: 'Payroll Checking', accountType: 'Checking', mask: '5678' },
    type: 'Book Transfer',
    status: 'Settled',
  },
  {
    id: 'txn-0130-02',
    createdDate: '2026-01-30T17:00:00.000Z',
    amountCents: -94348762,
    sender: { name: 'Operating', accountType: 'Checking', mask: '1234' },
    recipient: { name: 'Treasury', accountType: 'Treasury', mask: '9021' },
    type: 'Book Transfer',
    status: 'Scheduled',
  },
  {
    id: 'txn-0130-03',
    createdDate: '2026-01-30T14:35:00.000Z',
    amountCents: 17500000,
    sender: { name: 'Big Enterprise Corp', accountType: 'Checking', mask: '8830' },
    recipient: { name: 'Operating', accountType: 'Checking', mask: '1234' },
    type: 'Wire-US',
    status: 'Pending',
  },
  {
    id: 'txn-0130-04',
    createdDate: '2026-01-30T12:05:00.000Z',
    amountCents: -32500000,
    sender: { name: 'Operating', accountType: 'Checking', mask: '1234' },
    recipient: { name: 'Server Farm Boys', accountType: 'Checking', mask: '2214' },
    type: 'Wire-US',
    status: 'Pending',
  },
  {
    id: 'txn-0129-01',
    createdDate: '2026-01-29T20:30:00.000Z',
    amountCents: -14854121,
    sender: { name: 'Operating', accountType: 'Checking', mask: '1234' },
    recipient: { name: '14 vendors', accountType: 'Bill Pay', detail: 'February vendor run' },
    type: 'ACH-US',
    status: 'Pending',
  },
  {
    id: 'txn-0129-02',
    createdDate: '2026-01-29T13:15:00.000Z',
    amountCents: 2137442,
    sender: { name: 'Atlas Card Network', accountType: 'Card Settlement', mask: '0088' },
    recipient: { name: 'Operating', accountType: 'Checking', mask: '1234' },
    type: 'ACH-US',
    status: 'Settled',
  },
  {
    id: 'txn-0128-01',
    createdDate: '2026-01-28T18:40:00.000Z',
    amountCents: -1275000,
    sender: { name: 'Operating', accountType: 'Checking', mask: '1234' },
    recipient: { name: 'Amazon Web Services', accountType: 'Checking', mask: '1010' },
    type: 'ACH-US',
    status: 'Settled',
  },
  {
    id: 'txn-0128-02',
    createdDate: '2026-01-28T16:05:00.000Z',
    amountCents: 8500000,
    sender: { name: 'Northstar Systems Inc', accountType: 'Checking', mask: '8341' },
    recipient: { name: 'Operating', accountType: 'Checking', mask: '1234' },
    type: 'Wire-US',
    status: 'Settled',
  },
  {
    id: 'txn-0128-03',
    createdDate: '2026-01-28T11:25:00.000Z',
    amountCents: -269900,
    sender: { name: 'Operating', accountType: 'Checking', mask: '1234' },
    recipient: { name: 'Cloudflare', accountType: 'Checking', mask: '1101' },
    type: 'ACH-US',
    status: 'Settled',
  },
  {
    id: 'txn-0128-04',
    createdDate: '2026-01-28T09:00:00.000Z',
    amountCents: -450000,
    sender: { name: 'Operating', accountType: 'Checking', mask: '1234' },
    recipient: { name: 'Cooley LLP', accountType: 'Checking', mask: '7004' },
    type: 'ACH-US',
    status: 'Settled',
  },
  {
    id: 'txn-0127-01',
    createdDate: '2026-01-27T19:15:00.000Z',
    amountCents: -395000,
    sender: { name: 'Operating', accountType: 'Checking', mask: '1234' },
    recipient: { name: 'Figma', accountType: 'Checking', mask: '3006' },
    type: 'ACH-US',
    status: 'Settled',
  },
];

const PAYEES = [
  {
    id: 'py-4402',
    name: 'Definitely AGI Pty Ltd',
    accountType: 'Checking',
    mask: '4402',
    rail: 'wire_intl',
    country: 'AU',
    international: true,
  },
  {
    id: 'py-2214',
    name: 'Server Farm Boys',
    accountType: 'Checking',
    mask: '2214',
    rail: 'wire_us',
    country: 'US',
    international: false,
  },
  {
    id: 'py-8830',
    name: 'Big Enterprise Corp',
    accountType: 'Checking',
    mask: '8830',
    rail: 'wire_us',
    country: 'US',
    international: false,
  },
  {
    id: 'py-3159',
    name: 'Northstar Office Supply',
    accountType: 'Checking',
    mask: '3159',
    rail: 'ach_us',
    country: 'US',
    international: false,
  },
  {
    id: 'py-1101',
    name: 'Cloudflare',
    accountType: 'Checking',
    mask: '1101',
    rail: 'ach_us',
    country: 'US',
    international: false,
  },
];

const VENDORS = [
  { id: 'bpv-aws', name: 'Amazon Web Services', amountCents: 3350000, accountType: 'Checking', mask: '1010', rail: 'ACH-US' },
  { id: 'bpv-google', name: 'Google Workspace', amountCents: 1200000, accountType: 'Checking', mask: '2020', rail: 'ACH-US' },
  { id: 'bpv-slack', name: 'Slack', amountCents: 900000, accountType: 'Checking', mask: '3030', rail: 'ACH-US' },
  { id: 'bpv-notion', name: 'Notion', amountCents: 420000, accountType: 'Checking', mask: '4040', rail: 'ACH-US' },
  { id: 'bpv-figma', name: 'Figma', amountCents: 650000, accountType: 'Checking', mask: '5050', rail: 'ACH-US' },
  { id: 'bpv-datadog', name: 'Datadog', amountCents: 1700000, accountType: 'Checking', mask: '6060', rail: 'ACH-US' },
  { id: 'bpv-github', name: 'GitHub', amountCents: 1400000, accountType: 'Checking', mask: '7070', rail: 'ACH-US' },
  { id: 'bpv-snowflake', name: 'Snowflake', amountCents: 2150000, accountType: 'Checking', mask: '8080', rail: 'ACH-US' },
  { id: 'bpv-wework', name: 'WeWork', amountCents: 1200000, accountType: 'Checking', mask: '9090', rail: 'ACH-US' },
  { id: 'bpv-cooley', name: 'Cooley LLP', amountCents: 450000, accountType: 'Checking', mask: '7004', rail: 'ACH-US' },
  { id: 'bpv-carta', name: 'Carta', amountCents: 600000, accountType: 'Checking', mask: '1111', rail: 'ACH-US' },
  { id: 'bpv-linear', name: 'Linear', amountCents: 220000, accountType: 'Checking', mask: '1212', rail: 'ACH-US' },
  { id: 'bpv-vercel', name: 'Vercel', amountCents: 400000, accountType: 'Checking', mask: '1313', rail: 'ACH-US' },
  { id: 'bpv-openai', name: 'OpenAI', amountCents: 214121, accountType: 'Checking', mask: '1414', rail: 'ACH-US' },
];

const BATCHES = [
  {
    id: 'bp-0206',
    name: 'February vendor run',
    vendorCount: VENDORS.length,
    totalCents: VENDORS.reduce((sum, vendor) => sum + vendor.amountCents, 0),
    vendors: VENDORS,
  },
];

const PAYMENT_TYPES = {
  bill_pay_batch: 'Bill Pay',
  wire_us: 'Wire-US',
  wire_intl: 'Wire-INTL',
  ach_us: 'ACH-US',
  book_transfer: 'Book Transfer',
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The slow code path is the Rho Operating account / Move Funds payment request:',
  '- Service: `app/services/verticals/947c7934.js`',
  '- Route: `app/routes/verticals/947c7934.js`',
  '- Page: `app/public/verticals/947c7934.html` (served at `/rho`)',
  '- Test: `tests/947c7934-move-funds.test.js`',
  '',
  'The default 14-vendor Bill Pay batch succeeds but takes ~7s, breaching the 3000ms latency budget and triggering the latency alert.',
  'The culprit is `screenBatchPayees` in the service, which screens payees sequentially.',
  'Fix the latency without raising or removing the 3000ms budget, the breach alert, or the simulated per-payee screening latency.',
  'Preserve the response shape and payee order.',
  'Run `npx jest tests/947c7934-move-funds.test.js tests/sentry-webhook.test.js tests/verticals-registry.test.js` and eslint on the changed files.',
  'Verify the default Bill Pay batch at `/rho` returns in under 3 seconds.',
  'Open a fix pull request against `main`.',
].join('\n');

function validationError(message, code, requestId) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.statusCode = 400;
  error.code = code;
  error.requestId = requestId;
  return error;
}

function validatePositiveAmount(amountCents, requestId) {
  if (typeof amountCents !== 'number' || !Number.isInteger(amountCents) || amountCents <= 0) {
    throw validationError('Enter a positive whole-cent payment amount.', 'INVALID_AMOUNT', requestId);
  }
}

async function screenBatchPayees(payees) {
  const results = [];
  for (const payee of payees) {
    const { perPayeeMinMs, perPayeeMaxMs } = SCREENING_POLICY;
    await new Promise((resolve) => {
      setTimeout(resolve, perPayeeMinMs + Math.random() * (perPayeeMaxMs - perPayeeMinMs));
    });
    results.push({
      payeeId: payee.id,
      name: payee.name,
      status: 'cleared',
      checkedAt: new Date().toISOString(),
    });
  }
  return results;
}

function reportLatencyBreach(context) {
  const {
    requestId, durationMs, budgetMs, payeesChecked, data,
  } = context;
  const error = new Error(`POST ${ROUTE} took ${durationMs}ms (budget ${budgetMs}ms)`);
  error.name = 'LatencyBudgetExceeded';

  Sentry.captureException(error, {
    level: 'warning',
    tags: {
      route: ROUTE,
      service: SERVICE,
      alert_path: 'latency',
      payment_type: data.paymentType,
    },
    extra: {
      requestId,
      durationMs,
      budgetMs,
      payeesChecked,
      paymentType: data.paymentType,
    },
  });

  createSessionAndAlert({
    issueTitle: `LatencyBudgetExceeded: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/947c7934.js — screenBatchPayees',
    errorType: 'LatencyBudgetExceeded',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'Rho Move Funds',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: '947c7934',
    slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'payment_type', value: data.paymentType },
      { key: 'duration_ms', value: String(durationMs) },
    ],
    extra: {
      requestId,
      durationMs,
      budgetMs,
      payeesChecked,
      datadogMetric: 'payment.latency',
    },
    level: 'warning',
    platform: 'node',
    firstSeen: '',
    lastSeen: new Date().toISOString(),
    count: '',
    shortId: '',
    project: 'event-driven-devin',
    release: process.env.SENTRY_RELEASE || `${SERVICE}@1.0.0`,
    environment: process.env.DD_ENV || 'prod',
    triggeredRule: '',
  }).catch((alertError) => {
    logger.error('Failed to create Devin session for Rho move-funds latency breach', {
      error: alertError.message,
      requestId,
    });
  });
}

async function submitPayment(data = {}) {
  const startTime = Date.now();
  const requestId = `RHO-${uuidv4().slice(0, 8).toUpperCase()}`;
  const requestData = data && typeof data === 'object' ? data : {};
  const paymentType = requestData.paymentType === undefined ? 'bill_pay_batch' : requestData.paymentType;
  const normalized = { ...requestData, paymentType };

  if (requestData.fromAccount !== ACCOUNT.id) {
    throw validationError('Choose the Operating account as the source account.', 'UNKNOWN_FROM_ACCOUNT', requestId);
  }
  if (!Object.hasOwn(PAYMENT_TYPES, paymentType)) {
    throw validationError('Choose a supported payment type.', 'UNKNOWN_PAYMENT_TYPE', requestId);
  }

  let targets;
  let batch;
  let recipient;
  let amountCents;
  let memo;

  if (paymentType === 'bill_pay_batch') {
    const batchId = requestData.batchId === undefined ? 'bp-0206' : requestData.batchId;
    batch = BATCHES.find((entry) => entry.id === batchId);
    if (!batch) {
      throw validationError('Choose a valid Bill Pay batch.', 'UNKNOWN_BATCH', requestId);
    }
    targets = batch.vendors;
    recipient = `${batch.vendorCount} vendors`;
    amountCents = batch.totalCents;
    memo = typeof requestData.memo === 'string' && requestData.memo.trim()
      ? requestData.memo.trim()
      : batch.name;
  } else {
    if (typeof requestData.payeeId !== 'string' || !requestData.payeeId) {
      throw validationError('Choose a payee for this payment.', 'PAYEE_REQUIRED', requestId);
    }

    let payee;
    if (paymentType === 'book_transfer') {
      const allowedTargets = ['pay-5678', 'trs-9021'];
      if (!allowedTargets.includes(requestData.payeeId)) {
        throw validationError('Book transfers are only available to Payroll Checking or Treasury.', 'INVALID_TRANSFER_TARGET', requestId);
      }
      payee = ACCOUNTS.find((account) => account.id === requestData.payeeId);
    } else {
      payee = PAYEES.find((entry) => entry.id === requestData.payeeId);
      if (!payee) {
        throw validationError('Choose a valid payee.', 'UNKNOWN_PAYEE', requestId);
      }
      const railMismatch = (paymentType === 'wire_intl' && !payee.international)
        || ((paymentType === 'wire_us' || paymentType === 'ach_us') && payee.international);
      if (railMismatch) {
        throw validationError('The selected payment rail does not match the payee account.', 'RAIL_MISMATCH', requestId);
      }
    }

    if (!payee) {
      throw validationError('Choose a valid payee.', 'UNKNOWN_PAYEE', requestId);
    }
    validatePositiveAmount(requestData.amountCents, requestId);
    targets = [{
      id: payee.id,
      name: payee.name,
      accountType: payee.accountType || payee.type,
      mask: payee.mask,
    }];
    amountCents = requestData.amountCents;
    recipient = `${payee.name}${payee.mask ? ` ••••${payee.mask}` : ''}`;
    memo = typeof requestData.memo === 'string' ? requestData.memo.trim() : '';
  }

  if (amountCents > BALANCES.availableCents) {
    throw validationError('The payment amount exceeds the available balance.', 'INSUFFICIENT_FUNDS', requestId);
  }

  logger.info('Submitting Rho Move Funds payment', {
    requestId,
    paymentType,
    amountCents,
    payees: targets.length,
    service: SERVICE,
    route: ROUTE,
  });

  const screeningResults = await screenBatchPayees(targets);
  const durationMs = Date.now() - startTime;

  incrementMetric('payment.success', { route: ROUTE, payment_type: paymentType });
  recordTiming('payment.latency', durationMs, { route: ROUTE, payment_type: paymentType });

  if (durationMs > LATENCY_SLO.budgetMs) {
    incrementMetric('payment.latency_budget_breach', { route: ROUTE, payment_type: paymentType });
    logger.warn('Rho Move Funds payment exceeded latency budget', {
      requestId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      payeesChecked: screeningResults.length,
      paymentType,
      service: SERVICE,
    });
    logger.warn('Rho Move Funds latency breach — triggering Devin session', {
      requestId,
      service: SERVICE,
      route: ROUTE,
    });
    setImmediate(() => reportLatencyBreach({
      requestId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      payeesChecked: screeningResults.length,
      data: normalized,
    }));
  }

  return {
    success: true,
    requestId,
    payment: {
      id: `PAY-${uuidv4().slice(0, 8).toUpperCase()}`,
      type: paymentType,
      typeLabel: PAYMENT_TYPES[paymentType],
      status: 'Pending',
      amountCents,
      from: ACCOUNT,
      recipient,
      memo,
      createdAt: new Date().toISOString(),
    },
    screening: {
      checked: screeningResults.length,
      cleared: screeningResults.filter((result) => result.status === 'cleared').length,
      flagged: screeningResults.filter((result) => result.status !== 'cleared').length,
      results: screeningResults,
    },
    balances: {
      availableAfterCents: BALANCES.availableCents - amountCents,
    },
    durationMs,
    latencyBudgetMs: LATENCY_SLO.budgetMs,
  };
}

module.exports = {
  submitPayment,
  screenBatchPayees,
  ACCOUNT,
  ACCOUNTS,
  BALANCES,
  TRANSACTIONS,
  PAYEES,
  BATCHES,
  PAYMENT_TYPES,
  SCREENING_POLICY,
  LATENCY_SLO,
  REMEDIATION_DIRECTIVE,
};
