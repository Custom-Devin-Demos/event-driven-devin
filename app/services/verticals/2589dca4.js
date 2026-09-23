const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.CUSTOMER_2589DCA4_SLACK_MEMBER_ID || 'U0BU46F4WCU';
const DEVIN_USER_ID = process.env.DEVIN_USER_ID_2589DCA4 || 'user-5e154bb05983499ba384fbeadd3f4478';

const SERVICE = 'customer-2589dca4-money-plan';
const ROUTE = '/api/2589dca4/money-plan';

// Money Plan groups a customer's recent card and account activity into spend
// categories and applies a monthly cap per category. Categories are keyed by
// the merchant category code (MCC) carried on each transaction.
const SPEND_CATEGORY_RULES = {
  5411: { id: 'groceries', label: 'Groceries', monthlyCap: 900, essential: true },
  5812: { id: 'dining', label: 'Eating out', monthlyCap: 320, essential: false },
  4111: { id: 'transport', label: 'Transport', monthlyCap: 240, essential: true },
  4900: { id: 'utilities', label: 'Utilities', monthlyCap: 380, essential: true },
  5732: { id: 'electronics', label: 'Electronics', monthlyCap: 150, essential: false },
  7997: { id: 'fitness', label: 'Health & fitness', monthlyCap: 120, essential: false },
  // buy-now-pay-later instalment MCC (6051) — pending category mapping
};

const CUSTOMER_PROFILES = {
  'everyday-smart-access': {
    customerId: 'CUS-4471902',
    accountLabel: 'Smart Access',
    accountNumber: '062-000 10345678',
    monthlyIncome: 6240,
    savingsGoal: { name: 'Japan trip', target: 9000, saved: 7385.2 },
  },
};

// The last 30 days of settled transactions as returned by the transaction feed.
const RECENT_TRANSACTIONS = [
  { id: 'TX-90211', merchant: 'Coles Online', merchantCategoryCode: '5411', amount: 186.4, postedAt: '2026-09-02' },
  { id: 'TX-90228', merchant: 'Opal Travel', merchantCategoryCode: '4111', amount: 52.8, postedAt: '2026-09-03' },
  { id: 'TX-90244', merchant: 'AGL Energy', merchantCategoryCode: '4900', amount: 214.95, postedAt: '2026-09-05' },
  { id: 'TX-90261', merchant: 'Guzman y Gomez', merchantCategoryCode: '5812', amount: 27.6, postedAt: '2026-09-06' },
  { id: 'TX-90277', merchant: 'Afterpay — JB Hi-Fi', merchantCategoryCode: '6051', amount: 74.75, postedAt: '2026-09-08' },
  { id: 'TX-90290', merchant: 'Woolworths Metro', merchantCategoryCode: '5411', amount: 63.2, postedAt: '2026-09-09' },
  { id: 'TX-90304', merchant: 'Anytime Fitness', merchantCategoryCode: '7997', amount: 64.9, postedAt: '2026-09-11' },
  { id: 'TX-90319', merchant: 'Zip Pay — Instalment 2 of 4', merchantCategoryCode: '6051', amount: 41.25, postedAt: '2026-09-15' },
];

const REMEDIATION_DIRECTIVE = `Repository: COG-GTM/event-driven-devin. Scope: only the customer 2589dca4 Money Plan failure below. This repository hosts many independent demo verticals, each with its own intentional bug and its own Sentry issues (for example POST /api/banking/transfer, POST /api/nab/payment and POST /api/storefront/checkout throw their own TypeErrors and generate constant background traffic). Ignore every issue that is not from POST /api/2589dca4/money-plan, do not investigate or modify any other vertical, and do not widen the Sentry or Datadog search beyond this route. The failing surface is the customer 2589dca4 home page at app/public/verticals/2589dca4.html (page route GET /2589dca4), whose hero "Explore Money Plan" button posts to POST /api/2589dca4/money-plan in app/routes/verticals/2589dca4.js. The Money Plan pipeline lives in app/services/verticals/2589dca4.js: buildMoneyPlan -> categoriseTransactions -> resolveSpendCategory, then buildCategoryBudgets -> applyCategoryCap. Start at resolveSpendCategory: it looks up SPEND_CATEGORY_RULES by the merchant category code on each transaction, and buy-now-pay-later instalments (MCC 6051) started arriving in the transaction feed with the 2026 instalment-payments refresh without a spend category rule, so the lookup returns undefined for those transactions and buildCategoryBudgets dereferences it while grouping spend by category. Register the missing instalments category rule and make an unmapped merchant category code fail as a handled Money Plan error routed to an "Uncategorised" bucket instead of a TypeError. Do not change the page's look and feel, and do not touch the other verticals' intentional bugs. Verify by starting the server (node app/server.js) and POSTing {"profileId":"everyday-smart-access"} to /api/2589dca4/money-plan, which must return a plan with a category for every transaction, and confirm npm run lint passes.

Reproduce before you diagnose. Your first action after reading the alert, before reading any source file and before proposing a cause, is to start the server (node app/server.js), open /2589dca4?repro=1 in a real browser and click the hero "Explore Money Plan" button with your screen recording, so the recording shows the page, the click and the failure toast in the bottom-right corner. Always use ?repro=1 for your own clicks: the request fails identically but raises no Sentry event, Slack alert or Devin session, so your reproduction does not alert anyone or spawn another session. Only once you have reproduced the failure yourself do you start investigating. If it does not reproduce, stop and report that instead of fixing anything.

Verification evidence is mandatory and must be visual, not curl-only: after the fix, repeat exactly the same /2589dca4?repro=1 browser click with a second screen recording, showing the success toast where the failure toast used to be. Attach both — an animated webp of the reproduction recording under a "Reproduction" heading and an animated webp of the post-fix recording plus a screenshot of the success toast under a "Fix Verification" heading — to the pull request, and post the same evidence as a comment on the PR. Do not report the fix as complete, and do not leave the PR description saying verification is pending, until both recordings are attached.`;

class MoneyPlanError extends Error {
  constructor(message, code, statusCode = 400) {
    super(message);
    this.name = 'MoneyPlanError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function resolveProfile(profileId) {
  const profile = CUSTOMER_PROFILES[profileId];
  if (!profile) {
    throw new MoneyPlanError(`Unknown customer profile '${profileId}'`, 'UNKNOWN_PROFILE');
  }
  return profile;
}

function loadRecentTransactions(profile) {
  return RECENT_TRANSACTIONS.map((transaction) => ({
    ...transaction,
    accountNumber: profile.accountNumber,
  }));
}

function resolveSpendCategory(merchantCategoryCode) {
  return SPEND_CATEGORY_RULES[merchantCategoryCode];
}

function categoriseTransactions(transactions) {
  return transactions.map((transaction) => ({
    ...transaction,
    category: resolveSpendCategory(transaction.merchantCategoryCode),
  }));
}

function applyCategoryCap(bucket) {
  const remaining = Math.round((bucket.monthlyCap - bucket.spent) * 100) / 100;
  return {
    ...bucket,
    spent: Math.round(bucket.spent * 100) / 100,
    remaining,
    status: remaining < 0 ? 'over' : remaining < bucket.monthlyCap * 0.15 ? 'close' : 'on-track',
  };
}

function buildCategoryBudgets(categorisedTransactions) {
  const buckets = {};
  for (const entry of categorisedTransactions) {
    const key = entry.category.id;
    if (!buckets[key]) {
      buckets[key] = {
        id: key,
        label: entry.category.label,
        monthlyCap: entry.category.monthlyCap,
        essential: entry.category.essential,
        spent: 0,
        transactionCount: 0,
      };
    }
    buckets[key].spent += entry.amount;
    buckets[key].transactionCount += 1;
  }
  return Object.values(buckets).map(applyCategoryCap);
}

function summarisePlan(profile, budgets) {
  const totalSpent = budgets.reduce((sum, bucket) => sum + bucket.spent, 0);
  const essentialSpent = budgets.filter((bucket) => bucket.essential).reduce((sum, bucket) => sum + bucket.spent, 0);
  const goal = profile.savingsGoal;
  return {
    totalSpent: Math.round(totalSpent * 100) / 100,
    essentialSpent: Math.round(essentialSpent * 100) / 100,
    discretionarySpent: Math.round((totalSpent - essentialSpent) * 100) / 100,
    safeToSpend: Math.round((profile.monthlyIncome - totalSpent) * 100) / 100,
    savingsGoal: { ...goal, progress: Math.round((goal.saved / goal.target) * 1000) / 10 },
  };
}

async function buildMoneyPlan(data) {
  const startTime = Date.now();
  const planId = `MP-${uuidv4().slice(0, 8).toUpperCase()}`;
  const profileId = data.profileId || 'everyday-smart-access';

  const profile = resolveProfile(profileId);

  logger.info('Building Money Plan snapshot', {
    planId,
    profileId,
    customerId: profile.customerId,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 120 + Math.random() * 160));

    const transactions = loadRecentTransactions(profile);
    const categorised = categoriseTransactions(transactions);
    const budgets = buildCategoryBudgets(categorised);
    const summary = summarisePlan(profile, budgets);
    const duration = Date.now() - startTime;

    incrementMetric('money_plan.build_success', {
      route: ROUTE,
      profile: profileId,
      categories: String(budgets.length),
    });
    recordTiming('money_plan.build_latency', duration, { route: ROUTE });

    return {
      success: true,
      planId,
      customerId: profile.customerId,
      account: { label: profile.accountLabel, number: profile.accountNumber },
      period: { from: '2026-09-01', to: '2026-09-30' },
      budgets,
      summary,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('money_plan.build_failure', {
      route: ROUTE,
      profile: profileId,
      errorClass: error.name,
    });
    recordTiming('money_plan.build_latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Money Plan snapshot build failed', {
      planId,
      profileId,
      customerId: profile.customerId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: SERVICE,
    });

    if (data.synthetic) {
      throw error;
    }

    Sentry.captureException(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        profile: profileId,
        alert_path: 'instant',
      },
      extra: {
        planId,
        customerId: profile.customerId,
        transactionCount: RECENT_TRANSACTIONS.length,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/2589dca4.js — buildCategoryBudgets',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId || DEVIN_USER_ID,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Customer 2589dca4 — Money Plan',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '2589dca4',
      slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'profile', value: profileId },
        { key: 'customerId', value: profile.customerId },
      ],
      extra: {
        planId,
        customerId: profile.customerId,
        transactionCount: RECENT_TRANSACTIONS.length,
      },
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
      logger.error('Failed to create Devin session for Money Plan error', {
        error: alertError.message,
        planId,
      });
    });

    throw error;
  }
}

module.exports = {
  buildMoneyPlan,
  categoriseTransactions,
  resolveSpendCategory,
  buildCategoryBudgets,
  MoneyPlanError,
  SPEND_CATEGORY_RULES,
  CUSTOMER_PROFILES,
};
