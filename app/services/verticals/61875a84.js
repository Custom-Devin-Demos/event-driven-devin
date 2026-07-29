const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Bank of America customer accounts for the transactions demo
 */
const ACCOUNTS = [
  { id: 'BOA-ADV-7741', name: 'Advantage Plus Banking', type: 'checking', balance: 12480.66, currency: 'USD' },
  { id: 'BOA-SAV-3309', name: 'Advantage Savings', type: 'savings', balance: 48210.40, currency: 'USD' },
  { id: 'BOA-CCR-9920', name: 'Customized Cash Rewards', type: 'credit', balance: -842.17, currency: 'USD' },
];

/**
 * Posted and pending activity shown on the account activity page
 */
const TRANSACTIONS = [
  { id: 'TXN-0001', date: '2026-06-22', description: 'Direct Deposit \u2014 Payroll', merchant: 'Northgate Systems', amount: 3120.00, type: 'credit', category: 'income', status: 'posted', account: 'BOA-ADV-7741' },
  { id: 'TXN-0002', date: '2026-06-21', description: 'Zelle to Maria Gonzalez', merchant: 'Zelle', amount: -200.00, type: 'debit', category: 'transfers', status: 'posted', account: 'BOA-ADV-7741' },
  { id: 'TXN-0003', date: '2026-06-20', description: 'Whole Foods Market', merchant: 'Whole Foods', amount: -134.88, type: 'debit', category: 'groceries', status: 'posted', account: 'BOA-ADV-7741' },
  { id: 'TXN-0004', date: '2026-06-19', description: 'Preferred Rewards Bonus', merchant: 'Bank of America', amount: 18.75, type: 'credit', category: 'rewards', status: 'posted', account: 'BOA-ADV-7741' },
  { id: 'TXN-0005', date: '2026-06-17', description: 'Domestic Wire \u2014 Oak Street Realty', merchant: 'Oak Street Realty', amount: -2500.00, type: 'debit', category: 'transfers', status: 'posted', account: 'BOA-ADV-7741' },
  { id: 'TXN-0006', date: '2026-06-15', description: 'Shell Service Station', merchant: 'Shell', amount: -68.42, type: 'debit', category: 'gas', status: 'posted', account: 'BOA-ADV-7741' },
  { id: 'TXN-0007', date: '2026-06-12', description: 'BankAmericard Payment', merchant: 'Bank of America', amount: -420.00, type: 'debit', category: 'bills', status: 'posted', account: 'BOA-ADV-7741' },
  { id: 'TXN-0008', date: '2026-06-09', description: 'Delta Air Lines 0062', merchant: 'Delta', amount: -612.30, type: 'debit', category: 'travel', status: 'posted', account: 'BOA-ADV-7741' },
  { id: 'TXN-0009', date: '2026-06-05', description: 'Interest Earned', merchant: 'Bank of America', amount: 41.18, type: 'credit', category: 'income', status: 'posted', account: 'BOA-SAV-3309' },
  { id: 'TXN-0010', date: '2026-06-02', description: 'Transfer to Advantage Savings', merchant: 'Bank of America', amount: -1000.00, type: 'debit', category: 'transfers', status: 'pending', account: 'BOA-ADV-7741' },
];

/**
 * Statement periods offered in the activity filter. Each period defines the
 * lookback window used to bound the transaction search.
 */
const STATEMENT_PERIODS = {
  'last-30': { label: 'Last 30 days', days: 30 },
  'last-90': { label: 'Last 90 days', days: 90 },
  'last-12-months': { label: 'Last 12 months', days: 365 },
  'year-to-date': { label: 'Year to date', days: 174 },
};

const CATEGORIES = ['all', 'income', 'transfers', 'groceries', 'gas', 'bills', 'travel', 'rewards'];

/**
 * Resolve the date bounds for a statement period.
 */
function resolveStatementPeriod(periodId) {
  const period = STATEMENT_PERIODS[periodId] || STATEMENT_PERIODS['last-30'];
  const end = new Date('2026-06-23T00:00:00Z');
  const start = new Date(end.getTime() - period.days * 24 * 60 * 60 * 1000);
  return { label: period.label, window: { start, end } };
}

/**
 * Filter account activity down to the requested period, account, and category.
 */
function filterTransactions(transactions, period, accountId, category) {
  const start = period.range.start;
  const end = period.range.end;
  return transactions.filter((txn) => {
    const when = new Date(`${txn.date}T00:00:00Z`);
    if (when < start || when > end) return false;
    if (accountId && txn.account !== accountId) return false;
    if (category && category !== 'all' && txn.category !== category) return false;
    return true;
  });
}

/**
 * Roll the filtered activity up into the totals shown above the table.
 */
function summarizeActivity(transactions, openingBalance) {
  const deposits = transactions.filter((t) => t.amount > 0).reduce((sum, t) => sum + t.amount, 0);
  const withdrawals = transactions.filter((t) => t.amount < 0).reduce((sum, t) => sum + Math.abs(t.amount), 0);
  return {
    count: transactions.length,
    deposits: deposits.toFixed(2),
    withdrawals: withdrawals.toFixed(2),
    netChange: (deposits - withdrawals).toFixed(2),
    endingBalance: (openingBalance + deposits - withdrawals).toFixed(2),
  };
}

/**
 * Search posted and pending activity for an account.
 */
async function searchTransactions(data) {
  const startTime = Date.now();
  const searchId = uuidv4();

  logger.info('Searching account activity', {
    searchId,
    accountId: data.accountId,
    period: data.period,
    category: data.category,
    service: 'boa-account-activity-api',
    route: '/api/61875a84/transactions',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const account = ACCOUNTS.find((a) => a.id === data.accountId) || ACCOUNTS[0];
    const period = resolveStatementPeriod(data.period);
    const results = filterTransactions(TRANSACTIONS, period, account.id, data.category);
    const summary = summarizeActivity(results, account.balance);

    const duration = Date.now() - startTime;

    incrementMetric('activity.search.success', {
      route: '/api/61875a84/transactions',
      period: data.period,
    });
    recordTiming('activity.search.latency', duration, {
      route: '/api/61875a84/transactions',
    });

    return {
      success: true,
      searchId,
      account: { id: account.id, name: account.name },
      period: period.label,
      summary,
      transactions: results,
      retrievedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('activity.search.failure', {
      route: '/api/61875a84/transactions',
      errorClass: error.name,
      period: data.period,
    });
    recordTiming('activity.search.latency', duration, {
      route: '/api/61875a84/transactions',
      error: 'true',
    });

    logger.error('Account activity search failed', {
      searchId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      accountId: data.accountId,
      period: data.period,
      service: 'boa-account-activity-api',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/61875a84/transactions',
        service: 'boa-account-activity-api',
        period: data.period,
      },
      extra: {
        searchId,
        accountId: data.accountId,
        category: data.category,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/61875a84.js \u2014 filterTransactions',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'boa-account-activity-api',
      verticalLabel: 'Bank of America Accounts | Transactions',
      customer: '61875a84',
      tags: [
        { key: 'route', value: '/api/61875a84/transactions' },
        { key: 'service', value: 'boa-account-activity-api' },
        { key: 'period', value: data.period },
      ],
      extra: { searchId, accountId: data.accountId, category: data.category },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'boa-account-activity@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from activity search error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { searchTransactions, ACCOUNTS, TRANSACTIONS, STATEMENT_PERIODS, CATEGORIES };
