const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'customer-4da81799-client-banking-portal';
const ROUTE = '/api/4da81799/transfer';
const SLACK_MEMBER_ID = process.env.STATESTREET_SLACK_MEMBER_ID || 'U0BQZBHCNMA';

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the State Street client banking portal transfer vertical:',
  '- Service: `app/services/verticals/4da81799.js`',
  '- Route: `app/routes/verticals/4da81799.js`',
  '- Page: `app/public/verticals/4da81799.html` (served at `/4da81799` and `/statestreet`)',
  '',
  'Start from the transfer instruction that failed and work back to the cash',
  'program the debit account is enrolled in — the crash site is downstream of',
  'the missing settlement configuration, not the cause of it.',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

/**
 * Settlement rails available to the client cash platform, keyed by the cash
 * program an account is enrolled in. Each rail carries its local cutoff and
 * the value-dating convention used to strike the settlement date.
 */
const SETTLEMENT_RAILS = {
  operating_cash_2024: {
    railName: 'Fedwire',
    cutoffLocal: '17:00',
    timezone: 'America/New_York',
    settlementLagDays: 0,
    feeUsd: 12.5,
  },
  custody_settlement_2024: {
    railName: 'DDA Book Transfer',
    cutoffLocal: '18:30',
    timezone: 'America/New_York',
    settlementLagDays: 0,
    feeUsd: 0,
  },
  liquidity_sweep_2025: {
    railName: 'Sweep Book Transfer',
    cutoffLocal: '16:00',
    timezone: 'America/New_York',
    settlementLagDays: 1,
    feeUsd: 0,
  },
};

/**
 * Client cash accounts shown on the portal dashboard.
 *
 * `LIQ-PLUS-4417` was migrated onto the 2026 enhanced liquidity program during
 * the September onboarding wave.
 */
const ACCOUNTS = {
  'OPR-1234': {
    accountId: 'OPR-1234',
    displayNumber: 'x1234',
    label: 'Operating Cash',
    currency: 'USD',
    availableBalance: 1175012.45,
    cashProgram: 'operating_cash_2024',
    debitEligible: true,
  },
  'LIQ-PLUS-4417': {
    accountId: 'LIQ-PLUS-4417',
    displayNumber: 'x4417',
    label: 'Liquidity Plus',
    currency: 'USD',
    availableBalance: 2423254.9,
    cashProgram: 'liquidity_plus_2026',
    debitEligible: true,
  },
  'CUS-2345': {
    accountId: 'CUS-2345',
    displayNumber: 'x2345',
    label: 'Custody Settlement',
    currency: 'USD',
    availableBalance: 6712374.18,
    cashProgram: 'custody_settlement_2024',
    debitEligible: true,
  },
};

const DEFAULT_FROM_ACCOUNT = 'LIQ-PLUS-4417';
const DEFAULT_TO_ACCOUNT = 'CUS-2345';

const CLIENT = {
  clientId: 'SSC-880214',
  name: 'Michael Reyes',
  entity: 'Halcyon State Employees Pension Trust',
  relationshipManager: 'M. Okafor',
};

class ValidationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
    this.code = code || 'INVALID_TRANSFER_REQUEST';
  }
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function resolveAccount(accountId, side) {
  const account = ACCOUNTS[accountId];
  if (!account) {
    throw new ValidationError(`Account ${accountId} is not available on this profile`, 'ACCOUNT_NOT_FOUND');
  }
  if (side === 'debit' && !account.debitEligible) {
    throw new ValidationError(`Account ${accountId} is not enabled for debits`, 'ACCOUNT_NOT_DEBIT_ELIGIBLE');
  }
  return account;
}

/**
 * Look up the settlement rail for the cash program an account is enrolled in.
 */
function resolveSettlementRail(account) {
  return SETTLEMENT_RAILS[account.cashProgram];
}

function addBusinessDays(date, days) {
  const result = new Date(date.getTime());
  let remaining = days;
  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() + 1);
    const day = result.getUTCDay();
    if (day !== 0 && day !== 6) {
      remaining -= 1;
    }
  }
  return result;
}

/**
 * Strike the settlement instruction for a transfer: which rail carries it,
 * whether it makes today's cutoff and the value date the client is quoted.
 */
function buildSettlementInstruction(fromAccount, amount, submittedAt) {
  const rail = resolveSettlementRail(fromAccount);
  const [cutoffHour, cutoffMinute] = rail.cutoffLocal.split(':').map(Number);

  const cutoff = new Date(submittedAt.getTime());
  cutoff.setUTCHours(cutoffHour + 4, cutoffMinute, 0, 0);
  const madeCutoff = submittedAt.getTime() <= cutoff.getTime();
  const valueDate = addBusinessDays(submittedAt, rail.settlementLagDays + (madeCutoff ? 0 : 1));

  return {
    railName: rail.railName,
    cutoffLocal: `${rail.cutoffLocal} ${rail.timezone}`,
    madeCutoff,
    valueDate: valueDate.toISOString().slice(0, 10),
    feeUsd: rail.feeUsd,
    netDebit: roundMoney(amount + rail.feeUsd),
  };
}

function validateTransfer(fromAccount, toAccount, amount) {
  if (fromAccount.accountId === toAccount.accountId) {
    throw new ValidationError('Choose two different accounts for a transfer', 'SAME_ACCOUNT');
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ValidationError('Enter a transfer amount greater than zero', 'INVALID_AMOUNT');
  }
  if (amount > fromAccount.availableBalance) {
    throw new ValidationError(
      `Transfer amount exceeds the available balance on ${fromAccount.label}`,
      'INSUFFICIENT_FUNDS',
    );
  }
  if (fromAccount.currency !== toAccount.currency) {
    throw new ValidationError('Cross-currency transfers must be booked through FX', 'CURRENCY_MISMATCH');
  }
}

/**
 * Submit a transfer between two client cash accounts and return the booked
 * confirmation shown in the portal.
 */
async function submitTransfer(data) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const fromAccountId = data.fromAccount || DEFAULT_FROM_ACCOUNT;
  const toAccountId = data.toAccount || DEFAULT_TO_ACCOUNT;
  const amount = Number(data.amount);

  logger.info('Submitting client cash transfer', {
    requestId,
    fromAccountId,
    toAccountId,
    amount,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const fromAccount = resolveAccount(fromAccountId, 'debit');
    const toAccount = resolveAccount(toAccountId, 'credit');
    validateTransfer(fromAccount, toAccount, amount);

    const submittedAt = new Date();
    const settlement = buildSettlementInstruction(fromAccount, amount, submittedAt);

    const confirmation = {
      confirmationId: `SST-${requestId.slice(0, 8).toUpperCase()}`,
      clientId: CLIENT.clientId,
      fromAccount: `${fromAccount.label} ${fromAccount.displayNumber}`,
      toAccount: `${toAccount.label} ${toAccount.displayNumber}`,
      amount: roundMoney(amount),
      currency: fromAccount.currency,
      submittedAt: submittedAt.toISOString(),
      settlement,
      remainingAvailable: roundMoney(fromAccount.availableBalance - settlement.netDebit),
    };

    const duration = Date.now() - startTime;
    incrementMetric('client_transfer.success', { route: ROUTE, cashProgram: fromAccount.cashProgram });
    recordTiming('client_transfer.latency', duration, { route: ROUTE });

    logger.info('Client cash transfer booked', {
      requestId,
      confirmationId: confirmation.confirmationId,
      rail: settlement.railName,
      durationMs: duration,
      service: SERVICE,
    });

    return { success: true, requestId, confirmation };
  } catch (error) {
    const duration = Date.now() - startTime;

    if (error instanceof ValidationError) {
      incrementMetric('client_transfer.rejected', { route: ROUTE, code: error.code });
      logger.warn('Client cash transfer rejected', {
        requestId,
        fromAccountId,
        toAccountId,
        code: error.code,
        error: error.message,
        service: SERVICE,
      });
      error.requestId = requestId;
      throw error;
    }

    incrementMetric('client_transfer.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('client_transfer.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Client cash transfer failed', {
      requestId,
      fromAccountId,
      toAccountId,
      amount,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE, service: SERVICE, fromAccount: fromAccountId, alert_path: 'instant',
      },
      extra: { requestId, toAccount: toAccountId, amount },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/4da81799.js \u2014 buildSettlementInstruction',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'State Street Client Banking Portal \u2014 Transfer',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '4da81799',
      slackMemberId: SLACK_MEMBER_ID,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'fromAccount', value: fromAccountId },
        { key: 'cashProgram', value: (ACCOUNTS[fromAccountId] || {}).cashProgram || 'unknown' },
      ],
      extra: { requestId, toAccount: toAccountId, amount },
      level: 'error',
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
      logger.error('Failed to create Devin session for client transfer error', {
        requestId,
        error: alertError.message,
      });
    });

    error.requestId = requestId;
    throw error;
  }
}

module.exports = {
  submitTransfer,
  ACCOUNTS,
  SETTLEMENT_RAILS,
  CLIENT,
  DEFAULT_FROM_ACCOUNT,
  DEFAULT_TO_ACCOUNT,
  REMEDIATION_DIRECTIVE,
};
