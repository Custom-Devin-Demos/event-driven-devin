const { tracer, incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const logger = require('../../telemetry/logger');

const ACCOUNTS = new Map([['CHQ-4826', { currency: 'CAD', available: 16420.75 }], ['SAV-7391', { currency: 'CAD', available: 32850.40 }]]);
const POSTING_RULES = { internal_cad: { settlementLedger: 'CAD-PERSONAL', fee: 0 } };

function validateTransfer(data = {}) {
  const amount = Number(data.amount);
  if (!ACCOUNTS.has(data.fromAccount) || !ACCOUNTS.has(data.toAccount) || data.fromAccount === data.toAccount ||
      !Number.isFinite(amount) || amount <= 0 || amount > ACCOUNTS.get(data.fromAccount).available) {
    throw Object.assign(new Error('Choose different accounts and an amount within your available funds.'), { code: 'INVALID_TRANSFER' });
  }
  return { fromAccount: data.fromAccount, toAccount: data.toAccount, amount, currency: 'CAD' };
}

function postingProfileFor(transfer) {
  return `own_accounts_${transfer.currency.toLowerCase()}`;
}

function buildPosting(transfer) {
  const rule = POSTING_RULES[postingProfileFor(transfer)];
  return { ...transfer, ledger: rule.settlementLedger, fee: rule.fee, success: true };
}

async function processTransfer(data) {
  const transfer = validateTransfer(data);
  const started = Date.now();
  const tags = { service: 'cibc-account-transfers-api', release: 'cibc-transfers@2026.11.3' };
  return tracer.trace('cibc.transfer.submit', { service: tags.service, tags }, async () => {
    try {
      return buildPosting(transfer);
    } catch (error) {
      incrementMetric('cibc.transfer.failure', tags);
      recordTiming('cibc.transfer.latency', Date.now() - started, tags);
      logger.error('CIBC account transfer posting failed', { ...tags, error: error.message, stack: error.stack });
      Sentry.captureException(error, { tags });
      throw error;
    }
  });
}

module.exports = { ACCOUNTS, processTransfer };
