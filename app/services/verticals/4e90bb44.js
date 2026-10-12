const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/rocket-companies/savings/apply';
const SERVICE = 'customer-rocket-companies-redfin-savings';

/**
 * Rocket Mortgage & Redfin savings tiers (rocketmortgage.com/redfin).
 * Buying with a Redfin agent and financing with Rocket Mortgage earns a lender
 * credit of 0.75% of the loan amount, up to $6,000. Buying *and* selling with
 * Redfin adds a Redfin commission discount equal to that lender credit, so the
 * combined savings top out at $12,000.
 */
const SAVINGS_TIERS = {
  buy: { id: 'buy', label: 'Buy, finance & save', lenderCreditRate: 0.0075, lenderCreditCap: 6000, commissionMatch: false, maxSavings: 6000 },
  'buy-sell': { id: 'buy-sell', label: 'Buy, sell & save most', lenderCreditRate: 0.0075, lenderCreditCap: 6000, commissionMatch: true, maxSavings: 12000 },
};

/**
 * Client records as they arrive from the unified client profile. Loans that
 * started at Rocket Mortgage carry a `servicing` block. Loans boarded from
 * Mr. Cooper after the acquisition keep the servicing-transfer record they were
 * migrated with.
 */
const CLIENTS = {
  'RKT-7731': {
    clientId: 'RKT-7731',
    firstName: 'Dana',
    lastName: 'Whitfield',
    tier: 'buy-sell',
    redfinAgent: 'Alicia Moreno, Redfin Dallas',
    purchase: { address: '4820 Preston Meadow Dr, Frisco, TX 75034', price: 585000, downPayment: 117000 },
    sale: { address: '2208 Ridgeview Ln, Plano, TX 75025', listPrice: 489000 },
    servicingTransfer: {
      priorServicer: 'Mr. Cooper',
      priorLoanNumber: '0712-448-3390',
      boardedLoanNumber: '3418852207',
      boardedAt: '2026-08-17',
      investor: 'FNMA',
      payoffEstimate: 301450,
    },
  },
  'RKT-4410': {
    clientId: 'RKT-4410',
    firstName: 'Marcus',
    lastName: 'Lee',
    tier: 'buy-sell',
    redfinAgent: 'Jordan Pike, Redfin Detroit',
    purchase: { address: '1187 Lakeshore Dr, Grosse Pointe, MI 48236', price: 800000, downPayment: 160000 },
    sale: { address: '3315 Woodward Ave, Royal Oak, MI 48073', listPrice: 515000 },
    servicing: {
      loanNumber: '3307194418',
      servicer: 'Rocket Mortgage',
      investor: 'FHLMC',
      payoffEstimate: 268900,
    },
  },
  'RKT-2291': {
    clientId: 'RKT-2291',
    firstName: 'Priya',
    lastName: 'Shah',
    tier: 'buy',
    redfinAgent: 'Sam Ortiz, Redfin Phoenix',
    purchase: { address: '9021 E Saguaro Vista Rd, Scottsdale, AZ 85255', price: 475000, downPayment: 95000 },
    sale: null,
  },
};

const DEFAULT_CLIENT_ID = 'RKT-7731';

const ROCKET_SLACK_MEMBER_ID = process.env.ROCKET_SLACK_MEMBER_ID || 'U0BU46F4WCU';
const ROCKET_DEVIN_USER_ID = process.env.DEVIN_USER_ID_4E90BB44 || 'user-5e154bb05983499ba384fbeadd3f4478';

const SENTRY_ISSUE_QUERY = 'is:unresolved loanNumber';

const REMEDIATION_DIRECTIVE = `Repository: COG-GTM/event-driven-devin. Scope: only the Rocket Mortgage & Redfin savings failure below. This repository hosts many independent demo verticals, each with its own intentional bug and its own Sentry issues (for example POST /api/banking/transfer, POST /api/cba/payment and POST /api/storefront/checkout throw their own TypeErrors and generate constant background traffic). Ignore every issue that is not from POST ${ROUTE}, do not investigate or modify any other vertical, and do not widen the Sentry or Datadog search beyond this route. The failing surface is the Rocket Mortgage & Redfin savings page at app/public/verticals/4e90bb44.html (served at /rocket-companies and /4e90bb44), whose "Apply my savings" button posts to POST ${ROUTE} in app/routes/verticals/4e90bb44.js. The pipeline lives in app/services/verticals/4e90bb44.js: applySavings -> priceSavings -> linkSaleTransaction -> currentLoanForSale. Start at currentLoanForSale: for the "Buy, sell & save most" tier it reads the client's current loan from client.servicing, but clients whose loans were boarded from Mr. Cooper after the acquisition (for example RKT-7731, Dana Whitfield) carry a servicingTransfer record instead and have no servicing block, so it dereferences undefined. Resolve the current loan from either shape (a boarded loan is now serviced by Rocket Mortgage under its boardedLoanNumber), and make a buy-and-sell client with no current loan record fail as a handled "We couldn't find the loan on the home you're selling" error (HTTP 409, no alert) instead of a TypeError. Do not change the savings tiers or amounts, do not change the page's look and feel, and do not touch the other verticals' intentional bugs. Verify by starting the server (node app/server.js) and POSTing {"clientId":"RKT-7731"} to ${ROUTE}, which must return success with lenderCredit 3510, commissionDiscount 3510 and totalSavings 7020, and confirm npm run lint passes.

Reproduce before you diagnose. Your first action after reading the alert, before reading any source file and before proposing a cause, is to start the server (node app/server.js), open /rocket-companies?repro=1 in a real browser and click "Apply my savings" for the pre-selected client (Dana Whitfield) with your screen recording, so the recording shows the savings summary, the click and the error. Always use ?repro=1 for your own submissions: the request fails identically but raises no Sentry event, Slack alert or Devin session, so your reproduction does not alert anyone or spawn another session. Only once you have reproduced the failure yourself do you start investigating. If it does not reproduce, stop and report that instead of fixing anything.

Verification evidence is mandatory and must be visual, not curl-only: after the fix, repeat exactly the same /rocket-companies?repro=1 browser flow with a second screen recording, showing the savings confirmation where the error used to be. Attach both — an animated webp of the reproduction recording under a "Reproduction" heading and an animated webp of the post-fix recording plus a screenshot of the confirmation under a "Fix Verification" heading — to the pull request, and post the same evidence as a comment on the PR. Do not report the fix as complete, and do not leave the PR description saying verification is pending, until both recordings are attached.`;

function validationError(message, code = 'INVALID_REQUEST') {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = 400;
  return error;
}

function roundCents(value) {
  return Math.round(value * 100) / 100;
}

function loanAmount(client) {
  return client.purchase.price - client.purchase.downPayment;
}

function currentLoanForSale(client) {
  const servicing = client.servicing;
  return {
    loanNumber: servicing.loanNumber,
    servicer: servicing.servicer,
    investor: servicing.investor,
    payoffEstimate: servicing.payoffEstimate,
  };
}

function linkSaleTransaction(client) {
  const currentLoan = currentLoanForSale(client);
  return {
    address: client.sale.address,
    listPrice: client.sale.listPrice,
    currentLoan,
    estimatedEquity: client.sale.listPrice - currentLoan.payoffEstimate,
  };
}

function priceSavings(client) {
  const tier = SAVINGS_TIERS[client.tier];
  const amount = loanAmount(client);
  const lenderCredit = roundCents(Math.min(amount * tier.lenderCreditRate, tier.lenderCreditCap));
  const saleLink = tier.commissionMatch ? linkSaleTransaction(client) : null;
  const commissionDiscount = tier.commissionMatch ? lenderCredit : 0;
  return {
    tier: { id: tier.id, label: tier.label, maxSavings: tier.maxSavings },
    loanAmount: amount,
    lenderCredit,
    commissionDiscount,
    totalSavings: roundCents(lenderCredit + commissionDiscount),
    saleLink,
  };
}

function publicClient(client) {
  return {
    clientId: client.clientId,
    firstName: client.firstName,
    lastName: client.lastName,
    tier: client.tier,
    tierLabel: SAVINGS_TIERS[client.tier].label,
    redfinAgent: client.redfinAgent,
    purchase: client.purchase,
    loanAmount: loanAmount(client),
    sale: client.sale,
  };
}

async function applySavings(data) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const confirmationNumber = `RM-SAV-${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`;
  const clientId = String(data.clientId || '');
  const client = Object.hasOwn(CLIENTS, clientId) ? CLIENTS[clientId] : undefined;

  if (!client) throw validationError(`We couldn't find client ${clientId || '(none)'}`, 'UNKNOWN_CLIENT');

  logger.info('Applying Rocket Mortgage & Redfin savings', {
    requestId,
    confirmationNumber,
    clientId,
    tier: client.tier,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    const savings = priceSavings(client);
    const duration = Date.now() - startTime;

    incrementMetric('rocket_redfin_savings.success', { route: ROUTE, tier: client.tier });
    recordTiming('rocket_redfin_savings.latency', duration, { route: ROUTE });

    return {
      success: true,
      confirmationNumber,
      client: { clientId, firstName: client.firstName, lastName: client.lastName },
      purchase: client.purchase,
      redfinAgent: client.redfinAgent,
      ...savings,
      requestId,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('rocket_redfin_savings.failure', { route: ROUTE, errorClass: error.name, tier: client.tier });
    recordTiming('rocket_redfin_savings.latency', duration, { route: ROUTE, error: 'true' });

    const context = {
      requestId,
      confirmationNumber,
      clientId,
      tier: client.tier,
      loanAmount: loanAmount(client),
      hasServicing: Boolean(client.servicing),
      priorServicer: client.servicingTransfer ? client.servicingTransfer.priorServicer : null,
      boardedAt: client.servicingTransfer ? client.servicingTransfer.boardedAt : null,
    };

    logger.error('Rocket Mortgage & Redfin savings failed', {
      ...context,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: SERVICE,
    });

    if (data.synthetic) {
      logger.info('Reproduction run — savings failed without raising Sentry, Slack or a Devin session', {
        requestId,
        route: ROUTE,
      });
      error.requestId = requestId;
      throw error;
    }

    const tags = {
      route: ROUTE,
      service: SERVICE,
      tier: client.tier,
      priorServicer: context.priorServicer || 'none',
    };

    Sentry.captureException(error, { tags, extra: context });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=${encodeURIComponent(SENTRY_ISSUE_QUERY)}`,
      culprit: 'app/services/verticals/4e90bb44.js — currentLoanForSale',
      errorType: error.name || 'Error',
      errorValue: error.message,
      service: SERVICE,
      verticalLabel: 'Rocket Companies — Rocket Mortgage & Redfin savings',
      customer: '4e90bb44',
      slackMemberId: data.devinEmail ? '' : ROCKET_SLACK_MEMBER_ID,
      slackMemberIdFallback: ROCKET_SLACK_MEMBER_ID,
      devinUserId: data.devinUserId || ROCKET_DEVIN_USER_ID,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
      extra: context,
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
      logger.error('Failed to create Devin session for Rocket savings error', {
        requestId,
        error: alertError.message,
      });
    });

    error.requestId = requestId;
    throw error;
  }
}

module.exports = {
  applySavings,
  priceSavings,
  linkSaleTransaction,
  currentLoanForSale,
  publicClient,
  CLIENTS,
  SAVINGS_TIERS,
  DEFAULT_CLIENT_ID,
  REMEDIATION_DIRECTIVE,
};
