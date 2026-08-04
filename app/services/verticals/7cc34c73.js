const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Card expense ledger backing the Expenses inbox. Each expense carries the
 * compliance state that drives its review queue plus the budget, category and
 * card attributes the inbox filters narrow on.
 */
const EXPENSES = [
  { id: 'EXP-48211', date: '2026-08-03', merchant: 'Amazon Web Services', logo: 'AWS', amount: 18420.55, budget: 'Engineering Infrastructure', category: 'Software', card: 'Platform · 4417', owner: 'Priya Raman', receipt: true, memo: 'Aug reserved instances', compliance: 'compliant' },
  { id: 'EXP-48210', date: '2026-08-03', merchant: 'OpenAI', logo: 'OAI', amount: 6300.00, budget: 'AI Tooling', category: 'Software', card: 'Platform · 4417', owner: 'Priya Raman', receipt: true, memo: 'API usage', compliance: 'compliant' },
  { id: 'EXP-48209', date: '2026-08-03', merchant: 'Delta Air Lines', logo: 'DL', amount: 1284.30, budget: 'Sales Travel', category: 'Airfare', card: 'Travel · 9021', owner: 'Marcus Webb', receipt: false, memo: '', compliance: 'missing-receipt' },
  { id: 'EXP-48208', date: '2026-08-02', merchant: 'The Battery SF', logo: 'BT', amount: 940.12, budget: 'Sales Travel', category: 'Meals & Entertainment', card: 'Travel · 9021', owner: 'Marcus Webb', receipt: true, memo: '', compliance: 'missing-memo' },
  { id: 'EXP-48207', date: '2026-08-02', merchant: 'Figma', logo: 'FIG', amount: 2160.00, budget: 'Design Tools', category: 'Software', card: 'Platform · 4417', owner: 'Dana Whitfield', receipt: true, memo: 'Annual seats', compliance: 'compliant' },
  { id: 'EXP-48206', date: '2026-08-02', merchant: 'Marriott Union Square', logo: 'MAR', amount: 2734.88, budget: 'Sales Travel', category: 'Lodging', card: 'Travel · 9021', owner: 'Alicia Gomez', receipt: false, memo: 'SF onsite', compliance: 'missing-receipt' },
  { id: 'EXP-48205', date: '2026-08-01', merchant: 'Uber', logo: 'UB', amount: 88.40, budget: 'Sales Travel', category: 'Ground Transport', card: 'Travel · 9021', owner: 'Alicia Gomez', receipt: true, memo: 'Airport transfer', compliance: 'compliant' },
  { id: 'EXP-48204', date: '2026-08-01', merchant: 'Datadog', logo: 'DD', amount: 9875.00, budget: 'Engineering Infrastructure', category: 'Software', card: 'Platform · 4417', owner: 'Priya Raman', receipt: true, memo: 'Observability', compliance: 'compliant' },
  { id: 'EXP-48203', date: '2026-08-01', merchant: 'Apple Store', logo: 'APL', amount: 4218.00, budget: 'IT Equipment', category: 'Hardware', card: 'Operations · 2288', owner: 'Ken Osei', receipt: true, memo: 'Laptop refresh', compliance: 'over-limit' },
  { id: 'EXP-48202', date: '2026-07-31', merchant: 'WeWork', logo: 'WE', amount: 6120.00, budget: 'Facilities', category: 'Rent', card: 'Operations · 2288', owner: 'Ken Osei', receipt: true, memo: 'Aug desks', compliance: 'compliant' },
  { id: 'EXP-48201', date: '2026-07-31', merchant: 'Google Ads', logo: 'GA', amount: 22450.00, budget: 'Demand Generation', category: 'Advertising', card: 'Marketing · 7734', owner: 'Sofia Lindqvist', receipt: true, memo: 'Q3 search', compliance: 'compliant' },
  { id: 'EXP-48200', date: '2026-07-31', merchant: 'LinkedIn', logo: 'LI', amount: 8900.00, budget: 'Demand Generation', category: 'Advertising', card: 'Marketing · 7734', owner: 'Sofia Lindqvist', receipt: false, memo: 'Sponsored content', compliance: 'missing-receipt' },
  { id: 'EXP-48199', date: '2026-07-30', merchant: 'DoorDash', logo: 'DASH', amount: 312.75, budget: 'Team Meals', category: 'Meals & Entertainment', card: 'Operations · 2288', owner: 'Ken Osei', receipt: true, memo: 'Sprint review lunch', compliance: 'compliant' },
  { id: 'EXP-48198', date: '2026-07-30', merchant: 'Salesforce', logo: 'SF', amount: 31200.00, budget: 'Revenue Systems', category: 'Software', card: 'Platform · 4417', owner: 'Dana Whitfield', receipt: true, memo: 'Seat expansion', compliance: 'pending-approval' },
  { id: 'EXP-48197', date: '2026-07-29', merchant: 'United Airlines', logo: 'UA', amount: 2190.60, budget: 'Sales Travel', category: 'Airfare', card: 'Travel · 9021', owner: 'Marcus Webb', receipt: true, memo: 'NYC customer visit', compliance: 'compliant' },
  { id: 'EXP-48196', date: '2026-07-29', merchant: 'Notion', logo: 'NO', amount: 1440.00, budget: 'Design Tools', category: 'Software', card: 'Platform · 4417', owner: 'Dana Whitfield', receipt: false, memo: '', compliance: 'missing-receipt' },
  { id: 'EXP-48195', date: '2026-07-28', merchant: 'Slack', logo: 'SL', amount: 5210.00, budget: 'Revenue Systems', category: 'Software', card: 'Platform · 4417', owner: 'Priya Raman', receipt: true, memo: 'Grid plan', compliance: 'compliant' },
  { id: 'EXP-48194', date: '2026-07-28', merchant: 'Blue Bottle Coffee', logo: 'BB', amount: 64.20, budget: 'Team Meals', category: 'Meals & Entertainment', card: 'Operations · 2288', owner: 'Ken Osei', receipt: false, memo: '', compliance: 'missing-receipt' },
  { id: 'EXP-48193', date: '2026-07-27', merchant: 'Ramp Conference', logo: 'RC', amount: 15400.00, budget: 'Demand Generation', category: 'Conferences', card: 'Marketing · 7734', owner: 'Sofia Lindqvist', receipt: true, memo: 'Booth sponsorship', compliance: 'pending-approval' },
  { id: 'EXP-48192', date: '2026-07-27', merchant: 'Lyft', logo: 'LY', amount: 47.85, budget: 'Sales Travel', category: 'Ground Transport', card: 'Travel · 9021', owner: 'Alicia Gomez', receipt: true, memo: 'Client meeting', compliance: 'compliant' },
  { id: 'EXP-48191', date: '2026-07-26', merchant: 'Dell Technologies', logo: 'DE', amount: 12680.00, budget: 'IT Equipment', category: 'Hardware', card: 'Operations · 2288', owner: 'Ken Osei', receipt: true, memo: 'Workstations', compliance: 'over-limit' },
  { id: 'EXP-48190', date: '2026-07-26', merchant: 'Zoom', logo: 'ZM', amount: 3180.00, budget: 'Revenue Systems', category: 'Software', card: 'Platform · 4417', owner: 'Dana Whitfield', receipt: true, memo: 'Annual renewal', compliance: 'compliant' },
  { id: 'EXP-48189', date: '2026-07-25', merchant: 'Hilton Midtown', logo: 'HI', amount: 1875.40, budget: 'Sales Travel', category: 'Lodging', card: 'Travel · 9021', owner: 'Marcus Webb', receipt: false, memo: 'NYC customer visit', compliance: 'missing-receipt' },
  { id: 'EXP-48188', date: '2026-07-25', merchant: 'Gusto', logo: 'GU', amount: 7420.00, budget: 'Facilities', category: 'Professional Services', card: 'Operations · 2288', owner: 'Ken Osei', receipt: true, memo: 'Payroll fees', compliance: 'compliant' },
];

/**
 * Review queues surfaced as the Expenses inbox tabs. Each queue declares the
 * compliance states that belong in it.
 */
const REVIEW_QUEUES = [
  { id: 'all', label: 'All expenses', states: null },
  { id: 'not-compliant', label: 'Not compliant', states: ['missing-receipt', 'missing-memo', 'over-limit'] },
  { id: 'pending-review', label: 'Pending my review', states: ['pending-approval', 'over-limit'] },
  { id: 'missing-receipts', label: 'Missing receipts', states: ['missing-receipt'] },
];

/**
 * Registered filter definitions. Each rule code declares which ledger field it
 * narrows and how a selected value is compared against that field.
 */
const FILTER_RULES = [
  { code: 'RULE-QUEUE-STATE', label: 'Review queue', field: 'compliance', match: 'in' },
  { code: 'RULE-BUDGET', label: 'Budget', field: 'budget', match: 'equals' },
  { code: 'RULE-CATEGORY', label: 'Category', field: 'category', match: 'equals' },
  { code: 'RULE-CARD', label: 'Card', field: 'card', match: 'equals' },
];

const FILTER_DIMENSIONS = {
  budget: 'RULE-BUDGET',
  category: 'RULE-CATEGORY',
  card: 'RULE-CARD',
};

/**
 * Policy rules the accounting close forces onto any narrowed inbox query.
 * Expenses inside a locked accounting period must be excluded from review
 * queues, but this rule code has not been added to FILTER_RULES yet.
 */
const CLOSE_PERIOD_RULES = [
  { code: 'RULE-PERIOD-CLOSE-LOCK-2026-07', reason: 'July 2026 accounting period is locked for close' },
];

/**
 * Layers the accounting-close policy rules onto a narrowed inbox query.
 */
function applyClosePeriodRules(ruleLines, dimensions) {
  const isNarrowed = Object.keys(dimensions).length > 0;
  if (!isNarrowed) return ruleLines;
  const locks = CLOSE_PERIOD_RULES.map((rule) => ({ code: rule.code, value: null, source: 'close-policy' }));
  return [...ruleLines, ...locks];
}

/**
 * Resolves the requested queue + dimension selection into its rule plan.
 */
function resolveRulePlan(queueId, dimensions) {
  const queue = REVIEW_QUEUES.find((q) => q.id === queueId);
  if (!queue) {
    throw Object.assign(new Error(`Unknown review queue: ${queueId}`), { code: 'INVALID_QUEUE' });
  }
  const ruleLines = [];
  if (queue.states) {
    ruleLines.push({ code: 'RULE-QUEUE-STATE', value: queue.states, source: 'tab' });
  }
  Object.entries(dimensions).forEach(([dimension, value]) => {
    ruleLines.push({ code: FILTER_DIMENSIONS[dimension], value, source: 'filter' });
  });
  return { queue, ruleLines };
}

/**
 * Evaluates one resolved rule line against a ledger entry.
 */
function ruleMatches(ruleDef, value, expense) {
  const field = expense[ruleDef.field];
  if (ruleDef.match === 'in') return Array.isArray(value) && value.includes(field);
  return field === value;
}

/**
 * Builds the applied-rule summary for an inbox query — one entry per rule line,
 * resolving each rule code to its registered definition and match rule.
 * BUG: RULE-PERIOD-CLOSE-LOCK-2026-07 is not in FILTER_RULES, so reading
 * ruleDef.field on the undefined lookup result throws a TypeError.
 */
function buildRuleSummary(ruleLines) {
  return ruleLines.map((line) => {
    const ruleDef = FILTER_RULES.find((r) => r.code === line.code);
    const matched = EXPENSES.filter((expense) => ruleMatches(ruleDef, line.value, expense));
    return {
      code: line.code,
      label: ruleDef.label,
      field: ruleDef.field,
      match: ruleDef.match,
      value: line.value,
      source: line.source,
      matchCount: matched.length,
    };
  });
}

/**
 * Filters the card expense inbox for a reviewer's queue + filter selection and
 * returns the narrowed ledger along with totals and the applied-rule summary.
 */
async function filterExpenses(query) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const queueId = query.queue || 'all';
  const dimensions = {};
  ['budget', 'category', 'card'].forEach((dimension) => {
    if (query[dimension]) dimensions[dimension] = query[dimension];
  });

  logger.info('Filtering card expense inbox', {
    requestId,
    queue: queueId,
    dimensions,
    ledgerSize: EXPENSES.length,
    service: 'expense-inbox',
    route: '/api/7cc34c73/expenses/filter',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 120));

    const plan = resolveRulePlan(queueId, dimensions);
    const ruleLines = applyClosePeriodRules(plan.ruleLines, dimensions);
    const ruleSummary = buildRuleSummary(ruleLines);

    const results = EXPENSES.filter((expense) => ruleSummary.every(
      (rule) => ruleMatches(rule, rule.value, expense)
    ));
    const total = results.reduce((sum, expense) => sum + expense.amount, 0);
    const duration = Date.now() - startTime;

    incrementMetric('expenses.inbox.filter.success', {
      route: '/api/7cc34c73/expenses/filter',
      source: 'expense-inbox',
    });
    recordTiming('expenses.inbox.filter.latency', duration, {
      route: '/api/7cc34c73/expenses/filter',
    });

    return {
      success: true,
      requestId,
      queue: plan.queue.id,
      queueLabel: plan.queue.label,
      dimensions,
      count: results.length,
      total: Math.round(total * 100) / 100,
      appliedRules: ruleSummary,
      results,
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    logger.error('Expense inbox filter failed', {
      requestId,
      queue: queueId,
      dimensions,
      error: error.message,
      errorClass: error.constructor.name,
      durationMs: duration,
      service: 'expense-inbox',
    });

    incrementMetric('expenses.inbox.filter.failure', {
      route: '/api/7cc34c73/expenses/filter',
      error_type: error.constructor.name,
      source: 'expense-inbox',
    });
    recordTiming('expenses.inbox.filter.latency', duration, {
      route: '/api/7cc34c73/expenses/filter',
      error: 'true',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/7cc34c73/expenses/filter',
        service: 'expense-inbox',
        source: 'expense-inbox',
        customer: '7cc34c73',
      },
      extra: {
        requestId,
        queue: queueId,
        dimensions,
        ledgerSize: EXPENSES.length,
        registeredRules: FILTER_RULES.map((r) => r.code),
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.constructor.name}: ${error.message}`,
      issueUrl: process.env.SENTRY_ORG_SLUG && process.env.SENTRY_PROJECT_ID
        ? `https://${process.env.SENTRY_ORG_SLUG}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID}`
        : undefined,
      culprit: 'app/services/verticals/7cc34c73.js — buildRuleSummary',
      errorType: error.constructor.name,
      errorValue: error.message,
      customer: '7cc34c73',
      devinUserId: query.devinUserId,
      devinEmail: query.devinEmail,
      devinOrgId: query.devinOrgId,
      slackMemberId: 'U08S7AVJ478',
      service: 'expense-inbox',
      verticalLabel: 'Expenses Inbox — Review Queue Filter',
      tags: [
        { key: 'route', value: '/api/7cc34c73/expenses/filter' },
        { key: 'queue', value: queueId },
        { key: 'service', value: 'expense-inbox' },
      ],
      extra: {
        requestId,
        queue: queueId,
        dimensions,
        registeredRules: FILTER_RULES.map((r) => r.code),
      },
      level: 'error',
      platform: 'node',
      count: 1,
      shortId: `EXPENSE-INBOX-${requestId.slice(0, 6).toUpperCase()}`,
      environment: process.env.NODE_ENV || 'production',
      triggeredRule: 'Expense inbox filter errors',
    }).catch((alertError) => {
      logger.error('Failed to post alert for expense inbox failure', {
        requestId,
        error: alertError.message,
      });
    });

    throw error;
  }
}

module.exports = {
  EXPENSES,
  REVIEW_QUEUES,
  FILTER_RULES,
  filterExpenses,
};
