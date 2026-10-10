const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const jira = require('../jira');

const SERVICE = 'customer-b19cd3b6-dss-post';
const ROUTE = '/api/b19cd3b6/dss/post';
const REPO = 'COG-GTM/event-driven-devin';

const SLACK_MEMBER_ID = process.env.R365_SLACK_MEMBER_ID || 'U08S7AVJ478';
const JIRA_PROJECT_KEY = process.env.R365_JIRA_PROJECT_KEY || 'MBA';
const JIRA_ASSIGNEE_ACCOUNT_ID = process.env.R365_JIRA_ASSIGNEE_ACCOUNT_ID
  || '712020:b8c6e298-ac94-4127-b5d1-d5e182e57b49';

const TAX_RATE = 0.0825;

// POS payment tenders synced from the Toast integration.
const PAYMENT_TYPES = {
  cash: { label: 'Cash', source: 'Toast' },
  visa: { label: 'Visa', source: 'Toast' },
  mastercard: { label: 'Mastercard', source: 'Toast' },
  amex: { label: 'American Express', source: 'Toast' },
  gift_card: { label: 'Gift Card Redemption', source: 'Toast' },
  doordash_marketplace: { label: 'DoorDash Marketplace', source: 'DoorDash' },
  uber_eats: { label: 'Uber Eats', source: 'Uber' },
  doordash_drive: { label: 'DoorDash Drive', source: 'DoorDash' },
};

// Payment tender -> GL clearing account used when the DSS journal entry posts.
const GL_PAYMENT_MAP = {
  cash: { glAccount: '1010', name: 'Cash on Hand' },
  visa: { glAccount: '1120', name: 'Credit Card Clearing - Visa/MC' },
  mastercard: { glAccount: '1120', name: 'Credit Card Clearing - Visa/MC' },
  amex: { glAccount: '1125', name: 'Credit Card Clearing - Amex' },
  gift_card: { glAccount: '2300', name: 'Gift Card Liability' },
  doordash_marketplace: { glAccount: '1140', name: 'Third-Party Delivery Clearing - DoorDash' },
  uber_eats: { glAccount: '1150', name: 'Third-Party Delivery Clearing - Uber Eats' },
};

const GL_SALES_MAP = {
  food: { glAccount: '4000', name: 'Food Sales' },
  beverage: { glAccount: '4100', name: 'Beverage Sales' },
  alcohol: { glAccount: '4200', name: 'Liquor, Beer & Wine Sales' },
};

const GL_SALES_TAX = { glAccount: '2200', name: 'Sales Tax Payable' };

const SALES_CATEGORY_LABELS = {
  food: 'Food',
  beverage: 'Beverage',
  alcohol: 'Liquor, Beer & Wine',
};

const LOCATIONS = {
  104: {
    name: 'Downtown Austin - Congress Ave',
    number: '104',
    concept: 'Harvest Table Kitchen',
    manager: 'Maria Delgado',
    guests: 612,
    sales: { food: 8412.5, beverage: 2036.0, alcohol: 3118.75 },
    payments: {
      cash: 1204.1,
      visa: 5312.44,
      mastercard: 3108.92,
      amex: 1688.3,
      gift_card: 245.0,
      doordash_marketplace: 1402.19,
      uber_eats: 918.4,
      doordash_drive: 807.2,
    },
  },
  102: {
    name: 'South Lamar',
    number: '102',
    concept: 'Harvest Table Kitchen',
    manager: 'Devon Brooks',
    guests: 471,
    sales: { food: 6120.0, beverage: 1480.5, alcohol: 2204.25 },
    payments: {
      cash: 980.0,
      visa: 4102.33,
      mastercard: 2415.61,
      amex: 1250.7,
      gift_card: 120.0,
      doordash_marketplace: 1045.0,
      uber_eats: 700.0,
    },
  },
};

const REMEDIATION_DIRECTIVE = [
  `*Repository to investigate and fix:* \`${REPO}\``,
  '',
  'The failing code path is the Restaurant365 Daily Sales Summary (DSS) GL post:',
  '- Service: `app/services/verticals/b19cd3b6.js` (`buildJournalEntry`)',
  '- Route: `app/routes/verticals/b19cd3b6.js`',
  '- Page: `app/public/verticals/b19cd3b6.html` (served at `/restaurant365`)',
  '',
  '*Full remediation loop - complete every step:*',
  '1. Read the Jira ticket linked above (Jira REST API v3 with `JIRA_EMAIL`/`JIRA_API_TOKEN`, or the Atlassian MCP). Transition it to *In Progress* and comment that investigation has started with a link to this Devin session.',
  '2. Pull the Sentry event (Sentry MCP) and confirm the stack trace. Reproduce locally by starting the app and POSTing `{"locationId":"104"}` to `/api/b19cd3b6/dss/post`.',
  '3. Fix the root cause, not the symptom: every POS payment tender in `PAYMENT_TYPES` must have a GL clearing account. An unmapped tender must fail with an explicit 422 `ValidationError` naming the tender (a configuration problem for accounting to fix) instead of a `TypeError`. Add a regression test that asserts every `PAYMENT_TYPES` key is mapped in `GL_PAYMENT_MAP`.',
  '4. Preserve behavior for locations that already post (e.g. #102) and keep every journal entry balanced (debits = credits).',
  '5. Validate: `npx jest tests/b19cd3b6-dss-post.test.js --runInBand`, `npm test`, and `npm run lint` must pass. Start the app and verify in the browser that `/restaurant365` posts successfully for both #104 and #102.',
  '6. Open a pull request against `main` whose title starts with the Jira key and whose description links the Jira ticket and Sentry event. Comment the PR link, root cause, and fix summary on the Jira ticket and transition it to *In Review*.',
  '7. Review loop: wait for CI and Devin Review on the PR. Address every review comment with a follow-up commit, re-run the validation in step 5, and repeat until CI is green and no review comments are unresolved. Do not merge the PR.',
  '8. Post a final Jira comment summarizing validation results and review outcome.',
].join('\n');

function roundCents(value) {
  return Math.round(value * 100) / 100;
}

function validationError(message, code) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = 400;
  return error;
}

function validateRequest(data) {
  if (!data.locationId || !LOCATIONS[data.locationId]) {
    throw validationError('Select a location before posting the Daily Sales Summary.', 'DSS_LOCATION_REQUIRED');
  }
  if (data.businessDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(data.businessDate))) {
    throw validationError('Business date must be formatted YYYY-MM-DD.', 'DSS_DATE_INVALID');
  }
}

function getDailySalesSummary(locationId, businessDate) {
  const location = LOCATIONS[locationId];
  if (!location) return null;
  const sales = Object.entries(location.sales).map(([category, amount]) => ({
    category,
    label: SALES_CATEGORY_LABELS[category],
    amount,
  }));
  const netSales = roundCents(sales.reduce((sum, s) => sum + s.amount, 0));
  const tax = roundCents(netSales * TAX_RATE);
  const payments = Object.entries(location.payments).map(([type, amount]) => ({
    type,
    label: PAYMENT_TYPES[type].label,
    source: PAYMENT_TYPES[type].source,
    amount,
  }));
  const totalPayments = roundCents(payments.reduce((sum, p) => sum + p.amount, 0));
  return {
    locationId: location.number,
    locationName: location.name,
    concept: location.concept,
    manager: location.manager,
    businessDate: businessDate || new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10),
    guests: location.guests,
    sales,
    netSales,
    tax,
    grossSales: roundCents(netSales + tax),
    payments,
    totalPayments,
    overShort: roundCents(totalPayments - (netSales + tax)),
  };
}

function buildJournalEntry(dss) {
  const lines = [];
  dss.sales.forEach((sale) => {
    const account = GL_SALES_MAP[sale.category];
    lines.push({ glAccount: account.glAccount, account: account.name, debit: 0, credit: sale.amount });
  });
  lines.push({ glAccount: GL_SALES_TAX.glAccount, account: GL_SALES_TAX.name, debit: 0, credit: dss.tax });
  dss.payments.forEach((payment) => {
    const account = GL_PAYMENT_MAP[payment.type];
    lines.push({
      glAccount: account.glAccount,
      account: account.name,
      debit: payment.amount,
      credit: 0,
      memo: payment.label,
    });
  });
  const totalDebits = roundCents(lines.reduce((sum, l) => sum + l.debit, 0));
  const totalCredits = roundCents(lines.reduce((sum, l) => sum + l.credit, 0));
  return { lines, totalDebits, totalCredits, balanced: totalDebits === totalCredits };
}

/* ------------------------------------------------------------------ */
/*  Jira ticket                                                        */
/* ------------------------------------------------------------------ */

const text = (value, marks) => (marks ? { type: 'text', text: String(value), marks } : { type: 'text', text: String(value) });
const link = (label, href) => text(label, [{ type: 'link', attrs: { href } }]);
const strong = (value) => text(value, [{ type: 'strong' }]);
const code = (value) => text(value, [{ type: 'code' }]);
const para = (...content) => ({ type: 'paragraph', content });
const heading = (value, level = 3) => ({ type: 'heading', attrs: { level }, content: [text(value)] });
const bullets = (items) => ({
  type: 'bulletList',
  content: items.map((content) => ({ type: 'listItem', content: [para(...content)] })),
});
const ordered = (items) => ({
  type: 'orderedList',
  content: items.map((content) => ({ type: 'listItem', content: [para(...content)] })),
});
const codeBlock = (value, language = 'text') => ({ type: 'codeBlock', attrs: { language }, content: [text(value)] });

function sentryIssueUrl(eventId) {
  const org = process.env.SENTRY_ORG_SLUG || 'sentry-org';
  const project = process.env.SENTRY_PROJECT_ID || '';
  return `https://${org}.sentry.io/issues/?project=${project}&query=${eventId || 'is%3Aunresolved'}`;
}

function trimStack(stack) {
  const root = `${process.cwd()}/`;
  return String(stack || '').split('\n').slice(0, 8).map((line) => line.split(root).join('')).join('\n');
}

function buildJiraDescription({ error, postId, dss, sentryEventId, sentryUrl }) {
  const unmapped = dss.payments.filter((p) => !GL_PAYMENT_MAP[p.type]);
  return {
    type: 'doc',
    version: 1,
    content: [
      para(
        strong('Auto-filed from Sentry. '),
        text(`Posting the Daily Sales Summary to the general ledger failed for ${dss.concept} #${dss.locationId} (${dss.locationName}). `),
        text('Devin has been assigned to investigate and remediate.'),
      ),
      heading('Error'),
      bullets([
        [strong('Exception: '), code(`${error.name}: ${error.message}`)],
        [strong('Culprit: '), code('app/services/verticals/b19cd3b6.js - buildJournalEntry')],
        [strong('Route: '), code(`POST ${ROUTE}`)],
        [strong('Service: '), code(SERVICE)],
        [strong('Sentry event: '), sentryEventId ? link(sentryEventId, sentryUrl) : text('n/a')],
        [strong('Post ID: '), code(postId)],
      ]),
      heading('Stack trace'),
      codeBlock(trimStack(error.stack), 'javascript'),
      heading('Business impact'),
      bullets([
        [text(`DSS for business date ${dss.businessDate} is stuck in "Pending Approval"; $${dss.grossSales.toFixed(2)} in sales and ${dss.payments.length} payment tenders are not in the GL.`)],
        [text('Daily flash P&L, prime cost, and bank reconciliation for this location are blocked until the post succeeds.')],
        [text('Every location that accepts the affected tender(s) will fail the same way.')],
      ]),
      heading('Context'),
      bullets([
        [strong('Location: '), text(`#${dss.locationId} ${dss.locationName} (manager: ${dss.manager})`)],
        [strong('Payment tenders on the DSS: '), text(dss.payments.map((p) => p.label).join(', '))],
        [strong('Tenders with no GL mapping: '), text(unmapped.length ? unmapped.map((p) => `${p.label} (${p.type})`).join(', ') : 'none detected')],
      ]),
      heading('Steps to reproduce'),
      ordered([
        [text('Open '), code('/restaurant365'), text(' and select location #104 Downtown Austin.')],
        [text('Click '), strong('Approve & Post to GL'), text('.')],
        [text('Observe the 500 error and the Sentry event above.')],
      ]),
      heading('Expected vs actual'),
      bullets([
        [strong('Expected: '), text('A balanced journal entry posts to the GL and the DSS moves to "Posted".')],
        [strong('Actual: '), text(`The post throws ${error.name} and no journal entry is created.`)],
      ]),
      heading('Acceptance criteria'),
      bullets([
        [text('Every POS payment tender maps to a GL clearing account; #104 posts a balanced journal entry.')],
        [text('An unmapped tender fails with an explicit validation error naming the tender, not a TypeError.')],
        [text('Regression test asserts every PAYMENT_TYPES key is mapped in GL_PAYMENT_MAP.')],
        [text('Existing locations (e.g. #102) continue to post unchanged.')],
      ]),
      heading('Repository'),
      para(link(REPO, `https://github.com/${REPO}`)),
    ],
  };
}

async function fileJiraTicket(context) {
  if (!jira.isConfigured()) {
    logger.warn('Jira not configured — skipping Restaurant365 ticket', { postId: context.postId });
    return null;
  }
  try {
    const issue = await jira.createIssue({
      projectKey: JIRA_PROJECT_KEY,
      issueType: 'Bug',
      summary: `[Restaurant365] DSS post to GL fails with ${context.error.name} for #${context.dss.locationId} in ${REPO}`,
      description: buildJiraDescription(context),
      labels: ['restaurant365', 'sentry', 'devin-remediation', 'daily-sales-summary'],
      priority: 'High',
      assigneeAccountId: JIRA_ASSIGNEE_ACCOUNT_ID,
    });
    logger.info('Restaurant365 Jira ticket created', { key: issue.key, postId: context.postId });
    return issue;
  } catch (error) {
    logger.error('Failed to create Restaurant365 Jira ticket', {
      postId: context.postId,
      error: error.message,
      status: error.response?.status,
      data: error.response?.data,
    });
    return null;
  }
}

function buildPromptAppendix(issue, sentryEventId) {
  const header = issue
    ? [`*Jira ticket:* ${issue.key} - ${issue.url}`]
    : ['*Jira ticket:* not created (Jira unavailable) - skip the Jira steps below.'];
  if (sentryEventId) header.push(`*Sentry event ID:* \`${sentryEventId}\``);
  return [...header, '', REMEDIATION_DIRECTIVE].join('\n');
}

async function linkSessionOnTicket(issue, alertResult) {
  const sessionUrl = alertResult?.session?.url;
  if (!issue || !sessionUrl) return;
  try {
    await jira.addComment(issue.key, `Devin is investigating this issue: ${sessionUrl}`);
  } catch (error) {
    logger.warn('Failed to comment Devin session on Jira ticket', { key: issue.key, error: error.message });
  }
}

/* ------------------------------------------------------------------ */
/*  DSS post                                                           */
/* ------------------------------------------------------------------ */

async function postDailySalesSummary(data) {
  const startTime = Date.now();
  const postId = `DSS-${uuidv4().slice(0, 8).toUpperCase()}`;

  validateRequest(data);
  const dss = getDailySalesSummary(data.locationId, data.businessDate);

  logger.info('Posting Restaurant365 Daily Sales Summary', {
    postId, locationId: dss.locationId, businessDate: dss.businessDate, service: SERVICE, route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const journal = buildJournalEntry(dss);
    const duration = Date.now() - startTime;

    incrementMetric('dss_post.success', { route: ROUTE, locationId: dss.locationId });
    recordTiming('dss_post.latency', duration, { route: ROUTE });

    return {
      success: true,
      postId,
      status: 'posted',
      journalEntry: {
        number: `JE-${dss.businessDate.replace(/-/g, '')}-${dss.locationId}`,
        ...journal,
      },
      dss,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('dss_post.failure', { route: ROUTE, locationId: dss.locationId, errorClass: error.name });
    recordTiming('dss_post.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Restaurant365 DSS post failed', {
      postId, error: error.message, errorClass: error.name, durationMs: duration, locationId: dss.locationId, service: SERVICE,
    });

    const sentryEventId = Sentry.captureException(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        location_id: dss.locationId,
        alert_path: 'instant',
      },
      extra: { postId, businessDate: dss.businessDate, paymentTypes: dss.payments.map((p) => p.type) },
    });
    const sentryUrl = sentryIssueUrl(sentryEventId);

    const issue = await fileJiraTicket({ error, postId, dss, sentryEventId, sentryUrl });

    createSessionAndAlert({
      title: issue ? `${issue.key}: Restaurant365 DSS post failure` : 'Restaurant365 DSS post failure',
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: sentryUrl,
      culprit: 'app/services/verticals/b19cd3b6.js — buildJournalEntry',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Restaurant365 Daily Sales Summary',
      promptAppendix: buildPromptAppendix(issue, sentryEventId),
      customer: 'b19cd3b6',
      slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'location_id', value: dss.locationId },
        ...(issue ? [{ key: 'jira', value: issue.key }] : []),
      ],
      extra: {
        postId,
        businessDate: dss.businessDate,
        jiraKey: issue?.key || '',
        jiraUrl: issue?.url || '',
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
    })
      .then((result) => linkSessionOnTicket(issue, result))
      .catch((alertError) => {
        logger.error('Failed to create Devin session for Restaurant365 DSS error', { error: alertError.message, postId });
      });

    error.postId = postId;
    error.sentryEventId = sentryEventId;
    error.jira = issue ? { key: issue.key, url: issue.url } : null;
    throw error;
  }
}

module.exports = {
  postDailySalesSummary,
  getDailySalesSummary,
  buildJournalEntry,
  buildJiraDescription,
  buildPromptAppendix,
  LOCATIONS,
  PAYMENT_TYPES,
  GL_PAYMENT_MAP,
  REMEDIATION_DIRECTIVE,
  JIRA_PROJECT_KEY,
  JIRA_ASSIGNEE_ACCOUNT_ID,
};
