const { v4: uuidv4 } = require('uuid');
const { setTimeout: delay } = require('node:timers/promises');
const logger = require('../../telemetry/logger');
const { tracer, incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { ACCOUNTS } = require('../verticals/4da81799');

const SERVICE = 'statestreet-cash-transfer-api';
const ROUTE = '/api/oncall/statestreet/transfers';
const RELEASE = 'client-banking@2026.11.1';
const LEDGER_LOOKUP_MS = 550;

function invalidTransfer(message) {
  return Object.assign(new Error(message), { code: 'INVALID_TRANSFER' });
}

function validateTransfer({ fromAccount, toAccount, amount } = {}) {
  const from = typeof fromAccount === 'string' && Object.hasOwn(ACCOUNTS, fromAccount) ? ACCOUNTS[fromAccount] : null;
  const to = typeof toAccount === 'string' && Object.hasOwn(ACCOUNTS, toAccount) ? ACCOUNTS[toAccount] : null;
  if (!from || !to || !from.debitEligible || from === to
    || typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0
    || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001) {
    throw invalidTransfer('Choose different available accounts and a positive USD amount in whole cents.');
  }
  const feeCents = Math.max(250, Math.round(amount * 100 * 0.001));
  if (Math.round(amount * 100) + feeCents > Math.round(from.availableBalance * 100)) {
    throw invalidTransfer('The transfer and its fee exceed the available cash balance.');
  }
  return { from, to, amount, feeCents };
}

async function readLedgerBalance(accountId, transferId) {
  return tracer.trace('statestreet.ledger.balance', {
    service: SERVICE,
    resource: 'GET /cash-ledger/accounts/:id/balance',
    tags: { 'peer.service': 'institutional-cash-ledger', 'ledger.account_id': accountId },
  }, async () => {
    await delay(LEDGER_LOOKUP_MS);
    logger.info('State Street ledger balance received', { service: SERVICE, route: ROUTE, transferId, accountId });
    return ACCOUNTS[accountId].availableBalance;
  });
}

async function loadFundingBalances(lots, transferId) {
  const balances = new Map();
  for (const lot of lots) {
    balances.set(lot.accountId, await readLedgerBalance(lot.accountId, transferId));
  }
  return balances;
}

async function processCashTransfer(data) {
  const { from, to, amount, feeCents } = validateTransfer(data);
  const transferId = uuidv4();
  const started = Date.now();
  const tags = { service: SERVICE, route: ROUTE, release: RELEASE };
  return tracer.trace('statestreet.cash_transfer.submit', {
    service: SERVICE, resource: `POST ${ROUTE}`, tags,
  }, async () => {
    // Cash-program v2 represents each account as eight funding lots.
    const lots = [from, to].flatMap((account) => Array.from({ length: 8 }, (_, index) => ({
      id: `${account.accountId}-lot-${index + 1}`, accountId: account.accountId,
    })));
    const balances = await loadFundingBalances(lots, transferId);
    if (Math.round(balances.get(from.accountId) * 100) < Math.round(amount * 100) + feeCents) {
      throw invalidTransfer('The transfer and its fee exceed the available cash balance.');
    }
    const durationMs = Date.now() - started;
    incrementMetric('statestreet.cash_transfer.success', tags);
    recordTiming('statestreet.cash_transfer.latency', durationMs, tags);
    logger.info('State Street cash transfer completed', { ...tags, transferId, durationMs, fundingLots: lots.length });
    return {
      success: true, transferId, status: 'completed',
      receipt: {
        receiptId: `SS-RCP-${transferId.slice(0, 8).toUpperCase()}`,
        gatewayRef: `SS-GW-${transferId.slice(0, 8).toUpperCase()}`,
        from: from.accountId, to: to.accountId, amount,
        fee: (feeCents / 100).toFixed(2),
        totalDebit: ((Math.round(amount * 100) + feeCents) / 100).toFixed(2),
        timestamp: new Date().toISOString(),
      },
      fee: (feeCents / 100).toFixed(2),
      debitAmount: (Math.round(amount * 100) + feeCents) / 100,
    };
  });
}

module.exports = { processCashTransfer, LEDGER_LOOKUP_MS };
