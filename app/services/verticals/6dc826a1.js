const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const CLIENT_ACCOUNTS = {
  'WM-4417-20913': {
    accountNumber: 'WM-4417-20913',
    clientName: 'Ellison Family Trust',
    advisor: 'D. Katz',
    branch: 'New York — 1585 Broadway',
    programCode: 'consulting_group_advisor',
    programLabel: 'Consulting Group Advisor',
    cashAvailable: 1286430.18,
    marketValue: 12840915.22,
  },
  'WM-2210-88407': {
    accountNumber: 'WM-2210-88407',
    clientName: 'Whitfield Holdings LLC',
    advisor: 'D. Katz',
    branch: 'New York — 1585 Broadway',
    programCode: 'brokerage_full_service',
    programLabel: 'Full-Service Brokerage',
    cashAvailable: 128740.1,
    marketValue: 3204118.75,
  },
  'WM-9038-15602': {
    accountNumber: 'WM-9038-15602',
    clientName: 'Raman Charitable Remainder Trust',
    advisor: 'D. Katz',
    branch: 'Purchase, NY — 2000 Westchester',
    programCode: 'select_uma',
    programLabel: 'Select UMA',
    cashAvailable: 62105.44,
    marketValue: 1815330.9,
  },
};

const INSTRUMENTS = {
  AAPL: { symbol: 'AAPL', name: 'Apple Inc.', lastPrice: 227.48, assetClass: 'equity' },
  MSFT: { symbol: 'MSFT', name: 'Microsoft Corp.', lastPrice: 421.06, assetClass: 'equity' },
  MS: { symbol: 'MS', name: 'Morgan Stanley', lastPrice: 108.92, assetClass: 'equity' },
  VTI: { symbol: 'VTI', name: 'Vanguard Total Stock Market ETF', lastPrice: 289.34, assetClass: 'etf' },
  MSIFX: { symbol: 'MSIFX', name: 'MS Institutional Growth Fund', lastPrice: 64.71, assetClass: 'mutual_fund' },
};

const ORDER_TYPES = {
  market: {
    code: 'market',
    label: 'Market',
    feeScheduleCode: 'equity_market_agency',
    requiresLimitPrice: false,
  },
  limit: {
    code: 'limit',
    label: 'Limit (Day)',
    feeScheduleCode: 'equity_limit_agency',
    requiresLimitPrice: true,
  },
  advisory_wrap: {
    code: 'advisory_wrap',
    label: 'Advisory Wrap — Discretionary',
    feeScheduleCode: 'advisory_wrap_2026',
    requiresLimitPrice: false,
  },
};

const FEE_SCHEDULES = {
  equity_market_agency: {
    label: 'Equity Agency — Market',
    commissionBps: 12,
    minimumCommission: 24.95,
    ticketCharge: 4.95,
    secFeeBps: 0.278,
    settlementDays: 1,
    routingDesk: 'equity-agency',
  },
  equity_limit_agency: {
    label: 'Equity Agency — Limit',
    commissionBps: 9,
    minimumCommission: 19.95,
    ticketCharge: 4.95,
    secFeeBps: 0.278,
    settlementDays: 1,
    routingDesk: 'equity-agency',
  },
};

const ROUTING_DESKS = [
  {
    id: 'DESK-118',
    name: 'Equity Agency Desk',
    routingDesk: 'equity-agency',
    contact: '(212) 761-4118',
  },
  {
    id: 'DESK-204',
    name: 'Advisory Implementation Desk',
    routingDesk: 'advisory-implementation',
    contact: '(212) 761-4204',
  },
];

const VERTICAL_SLACK_MEMBER_ID = process.env.VERTICAL_6DC826A1_SLACK_MEMBER_ID || '';

const SENTRY_ISSUE_QUERY = 'is:unresolved commissionBps';

const REMEDIATION_DIRECTIVE = `Repository: COG-GTM/event-driven-devin. Scope: only the advisor trade booking failure below. This repository hosts many independent demo verticals, each with its own intentional bug and its own Sentry issues (for example POST /api/insurance/claim and POST /api/storefront/checkout throw their own TypeErrors and generate constant background traffic). Ignore every issue that is not from POST /api/6dc826a1/order, do not investigate or modify any other vertical, and do not widen the Sentry or Datadog search beyond this route. The failing surface is the wealth management advisor trade booking console at app/public/verticals/6dc826a1.html (page route GET /6dc826a1), whose "Submit Order" action posts to POST /api/6dc826a1/order in app/routes/verticals/6dc826a1.js. The order pricing pipeline lives in app/services/verticals/6dc826a1.js: submitOrder -> buildOrderPreview -> calculateCommission -> resolveFeeSchedule. Start at resolveFeeSchedule: it looks up FEE_SCHEDULES by the fee schedule code carried on the order type, and the advisory_wrap order type shipped in the UI tier with feeScheduleCode advisory_wrap_2026, which was never registered in FEE_SCHEDULES, so the lookup returns undefined and calculateCommission dereferences it while computing the commission. Register the missing fee schedule and make an unregistered schedule fail as a handled booking error routed to the advisory implementation desk instead of a TypeError. Do not change the page's look and feel, and do not touch the other verticals' intentional bugs. Verify by starting the server (node app/server.js) and POSTing an advisory wrap order for account WM-4417-20913 to /api/6dc826a1/order, which must return a successful order preview and confirmation, and confirm npm run lint and npm test pass.

Verification evidence is mandatory and must be visual, not curl-only: with the server running, open the /6dc826a1 page in a real browser, submit the pre-filled advisory wrap order for WM-4417-20913, and record your screen for the whole submission so the recording shows the ticket, the click, and the successful confirmation that replaces the previous TypeError panel. Attach a screenshot of that successful confirmation and an animated webp of the recording to the pull request under a "Fix Verification" heading, and post the same evidence as a comment on the PR. Do not report the fix as complete, and do not leave the PR description saying verification is pending, until that browser evidence is attached.`;

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function resolveFeeSchedule(orderType) {
  return FEE_SCHEDULES[orderType.feeScheduleCode];
}

function assignRoutingDesk(schedule) {
  return ROUTING_DESKS.find((desk) => desk.routingDesk === schedule.routingDesk);
}

function calculateCommission(orderType, principal) {
  const schedule = resolveFeeSchedule(orderType);
  const gross = principal * (schedule.commissionBps / 10000);
  const commission = Math.max(gross, schedule.minimumCommission);
  const secFee = principal * (schedule.secFeeBps / 100000);

  return {
    schedule,
    commissionBps: schedule.commissionBps,
    commission: roundMoney(commission),
    ticketCharge: roundMoney(schedule.ticketCharge),
    secFee: roundMoney(secFee),
    totalFees: roundMoney(commission + schedule.ticketCharge + secFee),
  };
}

function buildOrderPreview(account, instrument, orderType, quantity, limitPrice, side) {
  const executionPrice = orderType.requiresLimitPrice && limitPrice
    ? Number(limitPrice)
    : instrument.lastPrice;
  const principal = executionPrice * quantity;
  const fees = calculateCommission(orderType, principal);
  const desk = assignRoutingDesk(fees.schedule);
  const settlementDate = new Date();
  settlementDate.setUTCDate(settlementDate.getUTCDate() + fees.schedule.settlementDays + 1);
  const isSell = side === 'sell';
  const netAmount = isSell ? principal - fees.totalFees : principal + fees.totalFees;

  return {
    executionPrice: roundMoney(executionPrice),
    principal: roundMoney(principal),
    fees,
    desk,
    settlementDate: settlementDate.toISOString().slice(0, 10),
    estimatedProceeds: roundMoney(netAmount),
    cashRemaining: roundMoney(isSell
      ? account.cashAvailable + netAmount
      : account.cashAvailable - netAmount),
  };
}

function validationError(message) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = 'INVALID_ORDER';
  error.statusCode = 400;
  return error;
}

async function submitOrder(data) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const orderId = `MS-ORD-${uuidv4().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
  const accountNumber = data.accountNumber;
  const symbol = data.symbol ? String(data.symbol).toUpperCase() : '';
  const quantity = Number(data.quantity);
  const account = CLIENT_ACCOUNTS[accountNumber];
  const instrument = INSTRUMENTS[symbol];
  const orderType = ORDER_TYPES[data.orderType];

  if (!account) {
    throw validationError(`Unknown client account: ${accountNumber || '(none)'}`);
  }
  if (!instrument) {
    throw validationError(`Unknown symbol: ${symbol || '(none)'}`);
  }
  if (!orderType) {
    throw validationError(`Unknown order type: ${data.orderType || '(none)'}`);
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw validationError('Quantity must be a positive number of shares');
  }
  if (orderType.requiresLimitPrice && !Number(data.limitPrice)) {
    throw validationError('A limit price is required for limit orders');
  }

  logger.info('Booking advisor trade order', {
    requestId,
    orderId,
    accountNumber,
    symbol,
    quantity,
    orderType: orderType.code,
    side: data.side,
    service: '6dc826a1-api',
    route: '/api/6dc826a1/order',
  });

  await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 110));

  try {
    const preview = buildOrderPreview(
      account,
      instrument,
      orderType,
      quantity,
      data.limitPrice,
      data.side === 'sell' ? 'sell' : 'buy',
    );
    const duration = Date.now() - startTime;

    incrementMetric('trade_booking.success', {
      route: '/api/6dc826a1/order',
      orderType: orderType.code,
      programCode: account.programCode,
    });
    recordTiming('trade_booking.latency', duration, {
      route: '/api/6dc826a1/order',
    });

    logger.info('Advisor trade order booked', {
      requestId,
      orderId,
      accountNumber,
      durationMs: duration,
      service: '6dc826a1-api',
    });

    return {
      success: true,
      orderId,
      status: 'accepted',
      accountNumber,
      clientName: account.clientName,
      programLabel: account.programLabel,
      side: data.side === 'sell' ? 'Sell' : 'Buy',
      symbol: instrument.symbol,
      instrumentName: instrument.name,
      quantity,
      orderTypeLabel: orderType.label,
      feeScheduleLabel: preview.fees.schedule.label,
      executionPrice: preview.executionPrice,
      principal: preview.principal,
      commission: preview.fees.commission,
      ticketCharge: preview.fees.ticketCharge,
      secFee: preview.fees.secFee,
      totalFees: preview.fees.totalFees,
      estimatedProceeds: preview.estimatedProceeds,
      cashRemaining: preview.cashRemaining,
      settlementDate: preview.settlementDate,
      routingDesk: {
        id: preview.desk.id,
        name: preview.desk.name,
        contact: preview.desk.contact,
      },
      bookedAt: new Date().toISOString(),
      requestId,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const feeScheduleCode = orderType.feeScheduleCode;

    incrementMetric('trade_booking.failure', {
      route: '/api/6dc826a1/order',
      errorClass: error.name,
      orderType: orderType.code,
      feeScheduleCode,
    });
    recordTiming('trade_booking.latency', duration, {
      route: '/api/6dc826a1/order',
      error: 'true',
    });

    logger.error('Advisor trade order booking failed', {
      requestId,
      orderId,
      accountNumber,
      symbol,
      orderType: orderType.code,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: '6dc826a1-api',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/6dc826a1/order',
        service: '6dc826a1-api',
        orderType: orderType.code,
        feeScheduleCode,
      },
      extra: {
        requestId,
        orderId,
        accountNumber,
        symbol,
        quantity,
        feeScheduleCode,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=${encodeURIComponent(SENTRY_ISSUE_QUERY)}`,
      culprit: 'app/services/verticals/6dc826a1.js — calculateCommission',
      errorType: error.name || 'Error',
      errorValue: error.message,
      service: '6dc826a1-api',
      verticalLabel: 'Wealth Management — Advisor Trade Booking',
      slackMemberId: VERTICAL_SLACK_MEMBER_ID,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: [
        { key: 'route', value: '/api/6dc826a1/order' },
        { key: 'service', value: '6dc826a1-api' },
        { key: 'orderType', value: orderType.code },
        { key: 'feeScheduleCode', value: feeScheduleCode },
      ],
      extra: {
        requestId,
        orderId,
        accountNumber,
        symbol,
        quantity,
        side: data.side,
        feeScheduleCode,
        programCode: account.programCode,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || '6dc826a1@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for trade booking error', {
        requestId,
        error: alertError.message,
      });
    });

    throw error;
  }
}

module.exports = {
  submitOrder,
  buildOrderPreview,
  calculateCommission,
  resolveFeeSchedule,
  assignRoutingDesk,
  CLIENT_ACCOUNTS,
  INSTRUMENTS,
  ORDER_TYPES,
  FEE_SCHEDULES,
  ROUTING_DESKS,
  REMEDIATION_DIRECTIVE,
};
