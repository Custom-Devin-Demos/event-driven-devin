/* global setImmediate */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.SHARETEC_SLACK_MEMBER_ID || 'U08S7AVJ478';

const SERVICE = 'customer-924f5ec9-member-lookup';
const ROUTE = '/api/924f5ec9/member-lookup';

const LATENCY_SLO = { budgetMs: 3000 };
const LEDGER_FETCH_POLICY = { latencyMs: [450, 550] };

const LEDGERS = {
  shares: { label: 'Shares', system: 'Share ledger' },
  certificates: { label: 'Certificates', system: 'Certificate registry' },
  ira: { label: 'IRA', system: 'IRA custodian' },
  loans: { label: 'Loans', system: 'Loan servicing' },
  credit_cards: { label: 'Credit Cards', system: 'Card processor' },
  relationships: { label: 'Relations', system: 'Household directory' },
  transfers: { label: 'Transfers', system: 'Transfer desk' },
  ach_payroll: { label: 'ACH / Payroll', system: 'ACH origination' },
  notes: { label: 'Notes', system: 'Member notes' },
  ealerts: { label: 'eAlerts', system: 'Notification service' },
  ytd: { label: 'YTD', system: 'Tax reporting' },
  safe_deposit: { label: 'Safe Deposit', system: 'Branch vault' },
  fees: { label: 'Fees', system: 'Fee engine' },
  fraud_history: { label: 'Fraud History', system: 'Fraud case manager' },
};

const ALL_LEDGERS = Object.keys(LEDGERS);

const SCOPE_OPTIONS = {
  all: { label: 'All accounts & relationships', ledgers: ALL_LEDGERS },
  ...Object.fromEntries(ALL_LEDGERS.map((key) => [
    key,
    { label: LEDGERS[key].label, ledgers: [key] },
  ])),
};

const MEMBERS = {
  41000: {
    memberNumber: '41000',
    name: 'Sandra Dee',
    address: {
      line1: '123 Main St',
      city: 'Lino Lakes',
      state: 'MN',
      zip: '55014',
    },
    ssnLast4: '6151',
    dob: '1980-01-01',
    idLast4: '789',
    email: '',
    ledgers: {
      shares: [
        {
          id: '1',
          description: 'Saving for car',
          type: '001',
          certificate: '0',
          balanceCents: 908650,
          availableCents: 906150,
          status: 'Active',
        },
        {
          id: '2',
          description: 'spending money',
          type: '010',
          certificate: '0',
          balanceCents: 1065713,
          availableCents: 1063713,
          status: 'Active',
        },
      ],
      certificates: [
        {
          id: '3',
          description: '12 Month CD',
          type: '512',
          certificate: '4065',
          balanceCents: 500000,
          availableCents: 400000,
          status: 'Active',
        },
      ],
      ira: [
        {
          id: '4',
          description: 'Roth IRA',
          type: '400',
          certificate: '0',
          balanceCents: 311300,
          availableCents: 211299,
          status: 'Active',
        },
      ],
      loans: [
        {
          id: '1',
          collateral: 'Used Car Loan',
          currentBalanceCents: 706659,
          scheduledPaymentCents: 16340,
          delinquentCents: 0,
          payoffCents: 708576,
          dueDate: '2026-11-08',
        },
      ],
      credit_cards: [
        {
          id: '4417',
          description: 'Visa Platinum Rewards',
          blockCode: '',
          balanceCents: 124318,
          paymentCents: 3500,
          delinquentCents: 0,
          payoffCents: 124318,
          dueDate: '2026-10-28',
          creditLimitCents: 1000000,
        },
      ],
      relationships: [
        {
          memberNumber: '123',
          name: 'John M Langley',
          relation: 'Joint owner',
          shares: [
            {
              id: '1',
              description: 'Regular Shares',
              type: '001',
              certificate: '0',
              balanceCents: 23921884,
              availableCents: 23919384,
              status: 'Active',
            },
            {
              id: '2',
              description: 'Checking',
              type: '010',
              certificate: '0',
              balanceCents: 75024800,
              availableCents: 75022800,
              status: 'Active',
            },
          ],
          loans: [],
        },
        {
          memberNumber: '154570',
          name: 'Lani Smith',
          relation: 'Co-borrower',
          shares: [],
          loans: [
            {
              id: '2',
              collateral: 'NEW VEHICLE (0-999 miles)',
              currentBalanceCents: 458376,
              scheduledPaymentCents: 18047,
              delinquentCents: 0,
              payoffCents: 459494,
              dueDate: '2026-11-04',
            },
          ],
        },
      ],
      transfers: [
        {
          id: 'T-1001',
          title: 'Transfer to spending money',
          detail: 'From Saving for car to spending money — completed',
          date: '2026-10-21',
          amountCents: 50000,
        },
        {
          id: 'T-1002',
          title: 'Transfer to John M Langley',
          detail: 'Member-to-member transfer — scheduled weekly',
          date: '2026-11-02',
          amountCents: 12500,
        },
      ],
      ach_payroll: [
        {
          id: 'ACH-2210',
          title: 'Lino Lakes School District payroll',
          detail: 'Direct deposit — biweekly into spending money',
          date: '2026-10-24',
          amountCents: 214320,
        },
        {
          id: 'ACH-2211',
          title: 'Lino Lakes School District payroll',
          detail: 'Direct deposit — biweekly into spending money',
          date: '2026-11-07',
          amountCents: 214320,
        },
      ],
      notes: [
        {
          id: 'N-88',
          title: 'Travel notice',
          detail: 'Member flagged card for travel to Arizona Oct 18–26.',
          date: '2026-10-15',
          amountCents: null,
        },
        {
          id: 'N-89',
          title: 'Address confirmed',
          detail: 'Verified 123 Main St, Lino Lakes MN during branch visit.',
          date: '2026-10-28',
          amountCents: null,
        },
      ],
      ealerts: [
        {
          id: 'EA-14',
          title: 'Low balance alert',
          detail: 'spending money below $5,000 threshold — SMS + email',
          date: '2026-10-03',
          amountCents: null,
        },
        {
          id: 'EA-15',
          title: 'Loan payment due',
          detail: 'Used Car Loan payment reminder 3 days before due date',
          date: '2026-11-05',
          amountCents: null,
        },
      ],
      ytd: [
        {
          id: 'YTD-1',
          title: 'Dividends earned YTD',
          detail: 'Shares and certificates dividend credit',
          date: '2026-10-31',
          amountCents: 21408,
        },
        {
          id: 'YTD-2',
          title: 'Interest paid YTD',
          detail: 'Used Car Loan interest paid',
          date: '2026-10-31',
          amountCents: 18340,
        },
      ],
      safe_deposit: [
        {
          id: 'SD-214',
          title: 'Box 214 — Lino Lakes branch',
          detail: 'Small box, annual billing in January',
          date: '2026-01-12',
          amountCents: 4500,
        },
      ],
      fees: [
        {
          id: 'F-33',
          title: 'Cashier check fee',
          detail: 'Cashier check issued at Lino Lakes branch',
          date: '2026-09-30',
          amountCents: 500,
        },
      ],
      fraud_history: [
        {
          id: 'FR-09',
          title: 'Card-not-present attempt — cleared',
          detail: 'Visa 4417 online purchase declined, verified as member; case closed',
          date: '2026-08-19',
          amountCents: 7421,
        },
      ],
    },
  },
  41022: {
    memberNumber: '41022',
    name: 'Marcus Webb',
    address: {
      line1: '48 Birchwood Ln',
      city: 'Lino Lakes',
      state: 'MN',
      zip: '55014',
    },
    ssnLast4: '2204',
    dob: '1991-06-14',
    idLast4: '311',
    email: 'marcus.webb@example.com',
    ledgers: {
      shares: [
        {
          id: '1',
          description: 'Regular Shares',
          type: '001',
          certificate: '0',
          balanceCents: 412050,
          availableCents: 411550,
          status: 'Active',
        },
        {
          id: '2',
          description: 'Checking',
          type: '010',
          certificate: '0',
          balanceCents: 183440,
          availableCents: 183440,
          status: 'Active',
        },
      ],
      certificates: [
        {
          id: '3',
          description: '6 Month CD',
          type: '506',
          certificate: '3110',
          balanceCents: 100000,
          availableCents: 100000,
          status: 'Active',
        },
      ],
      ira: [],
      loans: [
        {
          id: '1',
          collateral: 'Personal Loan',
          currentBalanceCents: 402210,
          scheduledPaymentCents: 9500,
          delinquentCents: 0,
          payoffCents: 403800,
          dueDate: '2026-11-15',
        },
      ],
      credit_cards: [
        {
          id: '8820',
          description: 'Visa Classic',
          blockCode: '',
          balanceCents: 45890,
          paymentCents: 2500,
          delinquentCents: 0,
          payoffCents: 45890,
          dueDate: '2026-11-02',
          creditLimitCents: 500000,
        },
      ],
      relationships: [
        {
          memberNumber: '41000',
          name: 'Sandra Dee',
          relation: 'Authorized signer',
          shares: [
            {
              id: '2',
              description: 'spending money',
              type: '010',
              certificate: '0',
              balanceCents: 1065713,
              availableCents: 1063713,
              status: 'Active',
            },
          ],
          loans: [],
        },
      ],
      transfers: [
        {
          id: 'T-2040',
          title: 'Transfer to Checking',
          detail: 'From Regular Shares to Checking — completed',
          date: '2026-10-30',
          amountCents: 20000,
        },
      ],
      ach_payroll: [
        {
          id: 'ACH-910',
          title: 'Anoka County payroll',
          detail: 'Direct deposit — biweekly into Checking',
          date: '2026-10-31',
          amountCents: 162180,
        },
      ],
      notes: [
        {
          id: 'N-12',
          title: 'eStatement enrollment',
          detail: 'Member opted in to electronic statements.',
          date: '2026-09-12',
          amountCents: null,
        },
      ],
      ealerts: [
        {
          id: 'EA-4',
          title: 'Large withdrawal alert',
          detail: 'Checking withdrawals over $500 — email',
          date: '2026-07-22',
          amountCents: null,
        },
      ],
      ytd: [
        {
          id: 'YTD-1',
          title: 'Dividends earned YTD',
          detail: 'Share dividend credit',
          date: '2026-10-31',
          amountCents: 6102,
        },
      ],
      safe_deposit: [],
      fees: [
        {
          id: 'F-7',
          title: 'Overdraft transfer fee',
          detail: 'Automatic share-to-checking overdraft transfer',
          date: '2026-10-09',
          amountCents: 300,
        },
      ],
      fraud_history: [],
    },
  },
  41057: {
    memberNumber: '41057',
    name: 'Priya Raman',
    address: {
      line1: '920 Lakeview Dr',
      city: 'Circle Pines',
      state: 'MN',
      zip: '55014',
    },
    ssnLast4: '8890',
    dob: '1987-03-29',
    idLast4: '540',
    email: 'priya.raman@example.com',
    ledgers: {
      shares: [
        {
          id: '1',
          description: 'Regular Shares',
          type: '001',
          certificate: '0',
          balanceCents: 221480,
          availableCents: 221480,
          status: 'Active',
        },
      ],
      certificates: [],
      ira: [
        {
          id: '4',
          description: 'Traditional IRA',
          type: '401',
          certificate: '0',
          balanceCents: 98400,
          availableCents: 98400,
          status: 'Active',
        },
      ],
      loans: [
        {
          id: '1',
          collateral: 'Auto Loan — 2021 Civic',
          currentBalanceCents: 912300,
          scheduledPaymentCents: 22150,
          delinquentCents: 0,
          payoffCents: 914100,
          dueDate: '2026-11-20',
        },
      ],
      credit_cards: [],
      relationships: [
        {
          memberNumber: '41058',
          name: 'Arun Raman',
          relation: 'Joint owner',
          shares: [
            {
              id: '1',
              description: 'Regular Shares',
              type: '001',
              certificate: '0',
              balanceCents: 540900,
              availableCents: 540900,
              status: 'Active',
            },
          ],
          loans: [],
        },
      ],
      transfers: [
        {
          id: 'T-5112',
          title: 'Transfer to Arun Raman',
          detail: 'Member-to-member transfer — completed',
          date: '2026-10-18',
          amountCents: 7500,
        },
      ],
      ach_payroll: [
        {
          id: 'ACH-330',
          title: 'Medtronic payroll',
          detail: 'Direct deposit — semimonthly into Regular Shares',
          date: '2026-10-31',
          amountCents: 298410,
        },
      ],
      notes: [
        {
          id: 'N-41',
          title: 'Rate review request',
          detail: 'Member asked about auto loan refinance options.',
          date: '2026-10-27',
          amountCents: null,
        },
      ],
      ealerts: [
        {
          id: 'EA-9',
          title: 'Deposit posted alert',
          detail: 'Deposits over $1,000 — push notification',
          date: '2026-06-10',
          amountCents: null,
        },
      ],
      ytd: [
        {
          id: 'YTD-1',
          title: 'Dividends earned YTD',
          detail: 'Share dividend credit',
          date: '2026-10-31',
          amountCents: 3980,
        },
        {
          id: 'YTD-2',
          title: 'Interest paid YTD',
          detail: 'Auto loan interest paid',
          date: '2026-10-31',
          amountCents: 26110,
        },
      ],
      safe_deposit: [
        {
          id: 'SD-96',
          title: 'Box 96 — Circle Pines branch',
          detail: 'Medium box, annual billing in March',
          date: '2026-03-04',
          amountCents: 6000,
        },
      ],
      fees: [
        {
          id: 'F-15',
          title: 'Wire transfer fee',
          detail: 'Domestic outgoing wire to title company',
          date: '2026-10-05',
          amountCents: 2000,
        },
      ],
      fraud_history: [
        {
          id: 'FR-21',
          title: 'Duplicate charge dispute — resolved',
          detail: 'Duplicate merchant charge of $42.10 credited back; case closed',
          date: '2026-09-14',
          amountCents: 4210,
        },
      ],
    },
  },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The slow code path is the Sharetec Velocity member lookup request:',
  '- Service: `app/services/verticals/924f5ec9.js`',
  '- Route: `app/routes/verticals/924f5ec9.js`',
  '- Page: `app/public/verticals/924f5ec9.html` (served at `/sharetec`)',
  '- Test: `tests/924f5ec9-member-lookup.test.js`',
  '',
  'Member lookups with the default "All accounts & relationships" scope succeed but take ~7s, breaching the 3000ms latency budget and paging on-call.',
  'The culprit is `loadMemberLedgers` in the service.',
  'Find the root cause of the latency and fix it. Do not raise or remove the latency budget, the breach alert, or the simulated per-ledger fetch latency.',
  'Preserve the response payload for every scope, including the order of per-ledger results and the summary totals.',
  'Run `npx jest tests/924f5ec9-member-lookup.test.js --runInBand` and `npm run lint`.',
  'Verify the default member lookup at `/sharetec` returns in under 3 seconds.',
  'Open a pull request against `main` with the fix.',
].join('\n');

async function fetchLedger(member, ledgerKey) {
  const [min, max] = LEDGER_FETCH_POLICY.latencyMs;
  await new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));

  const ledger = LEDGERS[ledgerKey];
  const items = JSON.parse(JSON.stringify(member.ledgers[ledgerKey] || []));

  return {
    key: ledgerKey,
    label: ledger.label,
    system: ledger.system,
    itemCount: items.length,
    items,
  };
}

/**
 * Load each ledger in scope; results keep the scope's ledger order so the
 * member console can render its tabs consistently.
 */
async function loadMemberLedgers(member, ledgers) {
  const results = [];
  for (const ledgerKey of ledgers) {
    results.push(await fetchLedger(member, ledgerKey));
  }
  return results;
}

function summarize(ledgers) {
  const depositLedgers = ledgers.filter((l) => ['shares', 'certificates', 'ira'].includes(l.key));
  const loanLedgers = ledgers.filter((l) => l.key === 'loans');
  const cardLedgers = ledgers.filter((l) => l.key === 'credit_cards');
  const relationshipLedgers = ledgers.filter((l) => l.key === 'relationships');

  const totalSharesCents = depositLedgers
    .reduce((sum, l) => sum + l.items.reduce((s, item) => s + item.balanceCents, 0), 0);
  const totalLoansCents = loanLedgers
    .reduce((sum, l) => sum + l.items.reduce((s, item) => s + item.currentBalanceCents, 0), 0);
  const totalCardsCents = cardLedgers
    .reduce((sum, l) => sum + l.items.reduce((s, item) => s + item.balanceCents, 0), 0);
  const relationshipCount = relationshipLedgers
    .reduce((sum, l) => sum + l.items.length, 0);

  return {
    ledgersLoaded: ledgers.length,
    totalSharesCents,
    totalLoansCents,
    totalCardsCents,
    relationshipCount,
  };
}

function validateLookupRequest(data) {
  const validMemberNumber = typeof data.memberNumber === 'string' && /^\d{3,10}$/.test(data.memberNumber);
  const validScope = Object.hasOwn(SCOPE_OPTIONS, data.scope);

  if (!validMemberNumber || !validScope) {
    const error = new Error('Enter a member number (3–10 digits) and a valid account scope.');
    error.name = 'ValidationError';
    error.code = 'MEMBER_LOOKUP_INVALID';
    error.statusCode = 400;
    throw error;
  }
}

function reportLatencyBreach(context) {
  const {
    requestId, durationMs, budgetMs, ledgersLoaded, data,
  } = context;

  const error = new Error(`POST ${ROUTE} took ${durationMs}ms (budget ${budgetMs}ms)`);
  error.name = 'LatencyBudgetExceeded';

  Sentry.captureException(error, {
    level: 'warning',
    tags: {
      route: ROUTE,
      service: SERVICE,
      alert_path: 'latency',
      scope: data.scope,
    },
    extra: {
      requestId,
      durationMs,
      budgetMs,
      ledgersLoaded,
      memberNumber: data.memberNumber,
    },
  });

  createSessionAndAlert({
    issueTitle: `LatencyBudgetExceeded: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/924f5ec9.js — loadMemberLedgers',
    errorType: 'LatencyBudgetExceeded',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'Sharetec Velocity Member Lookup',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: '924f5ec9',
    slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'scope', value: data.scope },
      { key: 'duration_ms', value: String(durationMs) },
    ],
    extra: {
      requestId,
      durationMs,
      budgetMs,
      ledgersLoaded,
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
    logger.error('Failed to create Devin session for Sharetec member-lookup latency breach', {
      error: alertError.message,
      requestId,
    });
  });
}

async function lookupMember(data = {}) {
  const startTime = Date.now();
  const lookupId = `SHR-${uuidv4().slice(0, 8).toUpperCase()}`;
  const requestData = data && typeof data === 'object' ? data : {};
  const normalized = {
    ...requestData,
    memberNumber: requestData.memberNumber === undefined || requestData.memberNumber === null
      ? '41000'
      : String(requestData.memberNumber).trim(),
    scope: String(requestData.scope || 'all').trim().toLowerCase(),
  };

  validateLookupRequest(normalized);

  const member = MEMBERS[normalized.memberNumber];
  if (!member) {
    const error = new Error(`No member found for member number ${normalized.memberNumber}.`);
    error.name = 'MemberNotFoundError';
    error.code = 'MEMBER_NOT_FOUND';
    error.statusCode = 404;
    throw error;
  }

  const scope = SCOPE_OPTIONS[normalized.scope];

  logger.info('Running Sharetec member lookup', {
    lookupId,
    memberNumber: normalized.memberNumber,
    scope: normalized.scope,
    ledgers: scope.ledgers.length,
    service: SERVICE,
    route: ROUTE,
  });

  const ledgers = await loadMemberLedgers(member, scope.ledgers);
  const summary = summarize(ledgers);
  const durationMs = Date.now() - startTime;

  incrementMetric('member_lookup.success', {
    route: ROUTE,
    scope: normalized.scope,
  });
  recordTiming('member_lookup.latency', durationMs, {
    route: ROUTE,
  });

  if (durationMs > LATENCY_SLO.budgetMs) {
    incrementMetric('member_lookup.latency_budget_breach', {
      route: ROUTE,
      scope: normalized.scope,
    });
    logger.warn('Sharetec member lookup exceeded latency budget', {
      lookupId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      ledgersLoaded: ledgers.length,
      scope: normalized.scope,
      service: SERVICE,
    });
    logger.warn('Sharetec member lookup latency breach — triggering Devin session', {
      lookupId,
      service: SERVICE,
      route: ROUTE,
    });
    setImmediate(() => reportLatencyBreach({
      requestId: lookupId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      ledgersLoaded: ledgers.length,
      data: normalized,
    }));
  }

  return {
    success: true,
    lookupId,
    member: {
      memberNumber: member.memberNumber,
      name: member.name,
      address: member.address,
      ssnLast4: member.ssnLast4,
      dob: member.dob,
      idLast4: member.idLast4,
      email: member.email,
    },
    scope: {
      key: normalized.scope,
      label: scope.label,
    },
    ledgersLoaded: ledgers.length,
    ledgers,
    summary,
    durationMs,
  };
}

module.exports = {
  lookupMember,
  summarize,
  LEDGERS,
  ALL_LEDGERS,
  SCOPE_OPTIONS,
  MEMBERS,
  LEDGER_FETCH_POLICY,
  LATENCY_SLO,
  REMEDIATION_DIRECTIVE,
};
