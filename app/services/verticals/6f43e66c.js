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
const REQUEST_ROUTE = '/api/6f43e66c/request';

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
  'The failing code path is the consumer Zelle® vertical:',
  '- Service: `app/services/verticals/6f43e66c.js`',
  '- Accounts & limit profiles: `app/services/verticals/6f43e66c-accounts.js`',
  '- Route: `app/routes/verticals/6f43e66c.js`',
  '- Page: `app/public/verticals/6f43e66c.html` (served at `/6f43e66c` and `/bofa-snow`)',
  '- Prevention control: `scripts/6f43e66c-limits-audit.js` (`npm run audit:zelle`)',
  '',
  '*Treat this as a field-migration defect, not a one-line crash.* The FY26 limits refresh moved the enrolled limit profile on funding accounts to a new location (see `6f43e66c-accounts.js`). Every consumer of the old location is broken; only one of them crashes.',
  '',
  '*Remediation plan — once the crash is root-caused, run these three workstreams in parallel as child sessions, wait for them, then summarize in the ServiceNow incident:*',
  '1. *Blast radius in code* — find every consumer of the moved field in the service (send AND request paths, telemetry included). The request path does not crash: it silently falls back to the Standard profile, so Preferred Rewards Gold/Platinum customers are declined with HTTP 422 for amounts their tier allows. The only signal is the `zelle_request.declined` metric carrying `profile:Standard` on Gold/Platinum funding accounts. Route all consumers through one shared resolver that fails loudly when a profile cannot be resolved, add regression tests for both paths, run `npm test` and `npm run lint`.',
  '2. *Blast radius in ServiceNow* — using the same Table API credentials as the incident write-back, query open incidents in assignment group "Digital Payments Engineering" (state < 6) that predate this incident and mention Zelle requests, limits or declines. Decide which are the silent symptom of this same defect. For each: add a work note linking this incident and the fix PR, set `parent_incident` to this incident sys_id, and resolve it (`state` 6, `close_code` "Solution provided"). Report their numbers and count.',
  '3. *Prevention* — run `npm run audit:zelle`. It resolves limits for every funding account through both the send and request paths and exits non-zero on any unresolved or downgraded profile; it is not wired into CI, which is why this shipped. Wire it into `npm test` (or the CI workflow) so a limit-profile gap fails before it ships.',
  '',
  'Fold all code workstreams into a single pull request against `main`. If a child session cannot reach ServiceNow, perform workstream 2 from the parent session. The final ServiceNow work note must state: incidents linked and resolved (numbers), routes fixed, prevention control added, PR URL.',
].join('\n');

/**
 * Resolve the Zelle® send limits that apply to a funding account from the
 * limit profile the account is enrolled in.
 */
function resolveSendLimits(account) {
  return LIMIT_PROFILES[account.limitProfile];
}

/**
 * Resolve the limits that govern a Zelle® money request. Accounts that were
 * never enrolled in a Preferred Rewards profile fall back to Standard.
 */
function resolveRequestLimits(account) {
  return LIMIT_PROFILES[account.limitProfile || 'consumer-standard'];
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

/**
 * Request money from an enrolled Zelle® recipient.
 */
async function requestMoney(data) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const account = findFundingAccount(data.fromAccountId);
  const recipient = findRecipient(data.recipientId);
  const amountUsd = Number(data.amount);

  logger.info('Requesting money with Zelle', {
    requestId,
    fromAccountId: data.fromAccountId,
    recipientId: data.recipientId,
    amount: amountUsd,
    service: SERVICE,
    route: REQUEST_ROUTE,
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

    const limits = resolveRequestLimits(account);
    if (amountUsd > limits.perTransactionCap) {
      incrementMetric('zelle_request.declined', {
        route: REQUEST_ROUTE,
        profile: limits.label,
        fundingAccount: account.id,
      });
      logger.warn('Zelle request declined by limit profile', {
        requestId,
        amount: amountUsd,
        fundingAccount: account.id,
        profile: limits.label,
      });
      const error = new Error(
        `Requests from this account are limited to $${limits.perTransactionCap} (${limits.label})`,
      );
      error.name = 'LimitExceededError';
      error.statusCode = 422;
      error.code = 'REQUEST_LIMIT';
      throw error;
    }

    const requestedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    incrementMetric('zelle_request.completed', {
      route: REQUEST_ROUTE,
      tokenType: recipient.tokenType,
    });
    recordTiming('zelle_request.latency', Date.now() - startTime, {
      route: REQUEST_ROUTE,
      error: 'false',
    });

    return {
      requestId,
      status: 'requested',
      recipient: recipient.name,
      recipientToken: recipient.token,
      amount: amountUsd,
      memo: data.memo || '',
      fundingAccount: `${account.productLabel} \u2014 ****${account.last4}`,
      limitProfile: limits.label,
      expiresAt,
      requestedAt,
    };
  } catch (error) {
    recordTiming('zelle_request.latency', Date.now() - startTime, {
      route: REQUEST_ROUTE,
      error: 'true',
    });

    if (error.name === 'ValidationError' || error.name === 'LimitExceededError') {
      throw error;
    }

    logger.error('Zelle request failed', {
      requestId,
      amount: amountUsd,
      fundingAccount: account.id,
      error: error.message,
      errorClass: error.name,
      durationMs: Date.now() - startTime,
      service: SERVICE,
    });
    Sentry.captureException(error, {
      tags: {
        service: SERVICE,
        route: REQUEST_ROUTE,
        fundingAccount: account.id,
      },
      extra: {
        requestId,
        recipient: recipient.name,
        amount: amountUsd,
        limitProfile: account.limits.profile,
      },
    });
    throw error;
  }
}

module.exports = {
  sendMoney,
  requestMoney,
  FUNDING_ACCOUNTS,
  RECIPIENTS,
};
