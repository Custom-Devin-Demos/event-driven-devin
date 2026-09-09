const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const {
  FUNDING_ACCOUNTS,
  LIMIT_PROFILES,
  RECIPIENTS,
  findFundingAccount,
  findRecipient,
} = require('./6f43e66c-accounts');

const SERVICE = 'customer-6f43e66c-zelle-send';
const ROUTE = '/api/6f43e66c/send';

/** Slack member to page when a Zelle® send fails and no requester email is known. */
const ONCALL_SLACK_MEMBER_ID = process.env.DEMO_ONCALL_SLACK_MEMBER_ID || 'U08S7AVJ478';

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the consumer Zelle® send-money vertical:',
  '- Service: `app/services/verticals/6f43e66c.js`',
  '- Accounts & limit profiles: `app/services/verticals/6f43e66c-accounts.js`',
  '- Route: `app/routes/verticals/6f43e66c.js`',
  '- Page: `app/public/verticals/6f43e66c.html` (served at `/6f43e66c`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

/**
 * Resolve the Zelle® send limits that apply to a funding account from the
 * limit profile the account is enrolled in.
 */
function resolveSendLimits(account) {
  return LIMIT_PROFILES[account.limitProfile];
}

/**
 * Enforce per-transaction and daily caps for a send. Returns the headroom left
 * on the daily cap after this transfer so the confirmation can display it.
 */
function assertWithinLimits(amountUsd, limits, sentTodayUsd) {
  if (amountUsd > limits.perTransactionCap) {
    const error = new Error(`Amount exceeds the ${limits.label} per-transaction limit of $${limits.perTransactionCap}`);
    error.name = 'LimitExceededError';
    error.statusCode = 422;
    error.code = 'PER_TRANSACTION_LIMIT';
    throw error;
  }
  if (sentTodayUsd + amountUsd > limits.dailyCap) {
    const error = new Error(`Amount exceeds the ${limits.label} daily limit of $${limits.dailyCap}`);
    error.name = 'LimitExceededError';
    error.statusCode = 422;
    error.code = 'DAILY_LIMIT';
    throw error;
  }
  return limits.dailyCap - sentTodayUsd - amountUsd;
}

/**
 * Assemble the confirmation shown after a successful send.
 */
function buildConfirmation(transferId, account, recipient, amountUsd, memo, dailyHeadroom) {
  return {
    transferId,
    status: 'sent',
    recipient: recipient.name,
    recipientToken: recipient.token,
    amount: amountUsd,
    memo: memo || '',
    fundingAccount: `${account.productLabel} \u2014 ****${account.last4}`,
    dailyHeadroom,
    sentAt: new Date().toISOString(),
  };
}

/**
 * Send money to an enrolled Zelle® recipient from a consumer deposit account.
 */
async function sendMoney(data) {
  const startTime = Date.now();
  const transferId = uuidv4();
  const account = findFundingAccount(data.fromAccountId);
  const recipient = findRecipient(data.recipientId);
  const amountUsd = Number(data.amount);

  logger.info('Sending money with Zelle', {
    transferId,
    fromAccountId: data.fromAccountId,
    recipientId: data.recipientId,
    amount: amountUsd,
    service: SERVICE,
    route: ROUTE,
  });

  if (!account) {
    const error = new Error(`Unknown funding account: ${data.fromAccountId || '(none)'}`);
    error.name = 'ValidationError';
    error.statusCode = 400;
    error.code = 'ACCOUNT_NOT_ELIGIBLE';
    throw error;
  }

  if (!recipient) {
    const error = new Error('Recipient is not enrolled with Zelle');
    error.name = 'ValidationError';
    error.statusCode = 400;
    error.code = 'RECIPIENT_NOT_ENROLLED';
    throw error;
  }

  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    const error = new Error('Enter an amount greater than $0.00');
    error.name = 'ValidationError';
    error.statusCode = 400;
    error.code = 'INVALID_AMOUNT';
    throw error;
  }

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const limits = resolveSendLimits(account);
    const dailyHeadroom = assertWithinLimits(amountUsd, limits, 0);
    const confirmation = buildConfirmation(transferId, account, recipient, amountUsd, data.memo, dailyHeadroom);

    incrementMetric('zelle_send.completed', {
      route: ROUTE,
      tokenType: recipient.tokenType,
    });
    recordTiming('zelle_send.latency', Date.now() - startTime, {
      route: ROUTE,
      error: 'false',
    });

    logger.info('Zelle send completed', {
      transferId,
      recipient: recipient.name,
      amount: amountUsd,
      fundingAccount: account.id,
    });

    return confirmation;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('zelle_send.failure', {
      route: ROUTE,
      errorClass: error.name,
      fundingAccount: account.id,
    });
    recordTiming('zelle_send.latency', duration, {
      route: ROUTE,
      error: 'true',
    });

    logger.error('Zelle send failed', {
      transferId,
      recipient: recipient.name,
      amount: amountUsd,
      fundingAccount: account.id,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        service: SERVICE,
        route: ROUTE,
        fundingAccount: account.id,
      },
      extra: {
        transferId,
        recipient: recipient.name,
        amount: amountUsd,
        limitProfile: account.limits.profile,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/6f43e66c.js \u2014 assertWithinLimits',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Consumer Zelle Send',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '6f43e66c',
      slackMemberId: data.devinEmail ? '' : ONCALL_SLACK_MEMBER_ID,
      slackMemberIdFallback: ONCALL_SLACK_MEMBER_ID,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'fundingAccount', value: account.id },
      ],
      extra: {
        transferId,
        recipient: recipient.name,
        amount: amountUsd,
        limitProfile: account.limits.profile,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
    }).catch((alertError) => {
      logger.error('Failed to post alert for Zelle send error', {
        transferId,
        error: alertError.message,
      });
    });

    throw error;
  }
}

module.exports = {
  sendMoney,
  FUNDING_ACCOUNTS,
  RECIPIENTS,
};
