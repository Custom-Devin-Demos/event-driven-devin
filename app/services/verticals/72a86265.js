const { randomUUID } = require('crypto');
const Sentry = require('@sentry/node');
const { postAlertToSlack } = require('../slack');
const { getCustomerConfig } = require('../../../config/customers');
const logger = require('../../telemetry/logger');

// Synthetic demo data only: no real customers, accounts, balances or Bank of America systems.
const CUSTOMER = '72a86265';
const SERVICE = 'ciaran-bofa-accounts-web';
const ROUTE = 'POST /api/72a86265/transfers';
const CULPRIT = 'server/transfers.js — checkTransferLimits';
const ALERT_COOLDOWN_MS = Number(process.env.CIARAN_BOFA_ALERT_COOLDOWN_MS || 10 * 60 * 1000);
const MAX_SESSIONS = 500;

const SEED = {
  customer: { firstName: 'Alex', lastName: 'Morgan', memberSince: 2014 },
  accounts: [
    { id: 'chk-4821', type: 'checking', name: 'Advantage Plus Checking', mask: '4821', balance: 6842.17, available: 6542.17 },
    { id: 'sav-7730', type: 'savings', name: 'Advantage Savings', mask: '7730', balance: 18250.0, available: 18250.0 },
    { id: 'crd-1094', type: 'credit', name: 'Customized Cash Rewards Visa', mask: '1094', balance: -1286.44, available: 8713.56 },
  ],
  transactions: [
    { id: 'TX-1001', accountId: 'chk-4821', date: '2026-11-24', description: 'Payroll deposit - Northwind Corp', category: 'Income', amount: 3420.0 },
    { id: 'TX-1002', accountId: 'chk-4821', date: '2026-11-23', description: 'Harbor Grocers #112', category: 'Groceries', amount: -86.32 },
    { id: 'TX-1003', accountId: 'chk-4821', date: '2026-11-22', description: 'City Power & Light', category: 'Utilities', amount: -142.9 },
    { id: 'TX-1004', accountId: 'chk-4821', date: '2026-11-21', description: 'Transfer to Advantage Savings', category: 'Transfer', amount: -500.0 },
    { id: 'TX-1005', accountId: 'chk-4821', date: '2026-11-20', description: 'Bluebird Coffee', category: 'Dining', amount: -6.75 },
    { id: 'TX-1006', accountId: 'chk-4821', date: '2026-11-18', description: 'Riverside Apartments rent', category: 'Housing', amount: -2150.0 },
    { id: 'TX-2001', accountId: 'sav-7730', date: '2026-11-21', description: 'Transfer from Advantage Plus Checking', category: 'Transfer', amount: 500.0 },
    { id: 'TX-2002', accountId: 'sav-7730', date: '2026-10-31', description: 'Interest payment', category: 'Income', amount: 7.61 },
    { id: 'TX-3001', accountId: 'crd-1094', date: '2026-11-23', description: 'Metro Transit fare', category: 'Travel', amount: -2.9 },
    { id: 'TX-3002', accountId: 'crd-1094', date: '2026-11-19', description: 'Lumen Electronics', category: 'Shopping', amount: -389.99 },
    { id: 'TX-3003', accountId: 'crd-1094', date: '2026-11-15', description: 'Payment - thank you', category: 'Payment', amount: 600.0 },
  ],
};

// Limits are keyed by the destination account type. Credit-card payments were
// added to the transfer form without a matching entry here.
const TRANSFER_LIMITS = {
  checking: { perTransfer: 10000 },
  savings: { perTransfer: 25000 },
};

const SECURITY_CONTEXT = [
  'Service ciaran-bofa-accounts-web pins axios 0.21.1, lodash 4.17.20 and jsonwebtoken 8.5.1 (see SECURITY_FINDINGS.json, 31 open findings incl. CVE-2021-23337, CVE-2023-45857, CVE-2022-23539).',
  'Sibling services with open findings: ciaran-bofa-payments-api, ciaran-bofa-fx-rates, ciaran-bofa-trade-ledger.',
].join('\n');

const sessions = new Map();
let lastAlertAt = 0;

const round2 = (n) => Math.round(n * 100) / 100;
const clone = (v) => JSON.parse(JSON.stringify(v));
const httpError = (status, code, message) => Object.assign(new Error(message || code), { status, code });

function openSession() {
  if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  const token = randomUUID();
  sessions.set(token, clone(SEED));
  return { token, customer: SEED.customer };
}

function storeFor(token) {
  const store = token && sessions.get(token);
  if (!store) throw httpError(401, 'unauthorized', 'Session expired. Reload the page.');
  return store;
}

function accounts(token) {
  const store = storeFor(token);
  const sum = (list) => round2(list.reduce((t, a) => t + a.balance, 0));
  return {
    accounts: store.accounts,
    totals: { netWorth: sum(store.accounts), deposits: sum(store.accounts.filter((a) => a.type !== 'credit')) },
  };
}

function transactions(token, accountId) {
  const store = storeFor(token);
  const list = accountId ? store.transactions.filter((t) => t.accountId === accountId) : store.transactions;
  return { transactions: [...list].sort((a, b) => (a.date === b.date ? b.id.localeCompare(a.id) : b.date.localeCompare(a.date))).slice(0, 20) };
}

function checkTransferLimits(to, value) {
  const limit = TRANSFER_LIMITS[to.type];
  if (value > limit.perTransfer) throw httpError(422, 'limit_exceeded', 'Amount is above the per-transfer limit.');
}

function alertsEnabled(options) {
  return !options.reportsOff && !options.synthetic;
}

function raiseAlert(error, context) {
  const now = Date.now();
  if (now - lastAlertAt < ALERT_COOLDOWN_MS) {
    logger.info('Bank of America demo alert suppressed by cooldown', { service: SERVICE });
    return;
  }
  lastAlertAt = now;
  const alertData = {
    issueTitle: `${error.name}: ${error.message}`,
    culprit: CULPRIT,
    errorType: error.name,
    errorValue: error.message,
    customer: CUSTOMER,
    service: SERVICE,
    verticalLabel: 'Bank of America — Accounts (synthetic demo)',
    level: 'error',
    platform: 'node',
    environment: 'production',
    tags: Object.entries({ route: ROUTE, service: SERVICE, repo: 'cogdeasy/ciaran-bofa-accounts-web' }).map(([key, value]) => ({ key, value })),
    extra: { ...context, security: SECURITY_CONTEXT },
    customerConfig: getCustomerConfig(CUSTOMER),
  };
  // The Ciaran-org On-call responder watching the alerts channel investigates; no session is started here.
  postAlertToSlack(alertData).catch((err) => logger.error('Bank of America demo alert failed', { error: err.message }));
}

function transfer(token, body = {}, options = {}) {
  const store = storeFor(token);
  const from = store.accounts.find((a) => a.id === body.fromAccountId);
  const to = store.accounts.find((a) => a.id === body.toAccountId);
  const value = round2(Number(body.amount));
  if (!from || !to) throw httpError(400, 'unknown_account');
  if (from.id === to.id) throw httpError(400, 'same_account');
  if (from.type === 'credit') throw httpError(400, 'invalid_source');
  if (!(value > 0)) throw httpError(400, 'invalid_amount');
  if (value > from.available) throw httpError(422, 'insufficient_funds');

  const id = `PAY-${randomUUID().slice(0, 8).toUpperCase()}`;
  try {
    checkTransferLimits(to, value);
  } catch (error) {
    if (error.status) throw error;
    const context = { transferId: id, fromType: from.type, toType: to.type, amount: value };
    Sentry.captureException(error, { tags: { route: ROUTE, service: SERVICE, customer: CUSTOMER }, extra: context });
    logger.error('Bank of America demo transfer failed', { ...context, service: SERVICE, error: error.message });
    if (alertsEnabled(options)) raiseAlert(error, context);
    throw Object.assign(error, { status: 500, code: 'transfer_failed' });
  }

  from.balance = round2(from.balance - value);
  from.available = round2(from.available - value);
  to.balance = round2(to.balance + value);
  to.available = round2(to.available + value);
  const today = new Date().toISOString().slice(0, 10);
  store.transactions.push(
    { id: `TX-${id}-D`, accountId: from.id, date: today, description: `Transfer to ${to.name}`, category: 'Transfer', amount: -value },
    { id: `TX-${id}-C`, accountId: to.id, date: today, description: `Transfer from ${from.name}`, category: 'Transfer', amount: value },
  );
  return {
    id,
    status: 'ACCEPTED',
    message: `Transfer of $${value.toFixed(2)} from ${from.name} ...${from.mask} to ${to.name} ...${to.mask} submitted. Confirmation ${id}.`,
  };
}

function resetAlertCooldown() {
  lastAlertAt = 0;
}

module.exports = {
  CUSTOMER, SERVICE, ROUTE, CULPRIT, TRANSFER_LIMITS, SEED,
  openSession, accounts, transactions, transfer, resetAlertCooldown,
};
