const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const {
  BOOKING_ENTITIES, SETTLEMENT_LOCATIONS, addBusinessDays, calendarForEntity,
} = require('./87575bac-calendars');
const { submitInstruction } = require('./87575bac-depository');

const SLACK_MEMBER_ID = process.env.C87575BAC_SLACK_MEMBER_ID || '';
const SERVICE = 'settlement-instruction-service';
const ROUTE = '/api/87575bac/trades/:tradeId/release';
const BUSINESS_DATE = '2026-05-15';
const USDCAD = 1.3685;

const TRADES = [
  {
    tradeId: 'TDS-260515-004183', side: 'BUY', ticker: 'ENB', security: 'Enbridge Inc.', exchange: 'TSX', isin: 'CA29250N1050',
    client: 'Wellington Management Company LLP', clientType: 'US Institutional', bookingEntity: 'TDSUSA', settlementLocation: 'CDS',
    quantity: 125000, price: 64.82, currency: 'CAD', counterparty: 'BMO Nesbitt Burns Inc.', status: 'PENDING', execTime: '10:42:17',
  },
  {
    tradeId: 'TDS-260515-004127', side: 'SELL', ticker: 'SHOP', security: 'Shopify Inc.', exchange: 'TSX', isin: 'CA82509L1076',
    client: "Ontario Teachers' Pension Plan", clientType: 'CA Institutional', bookingEntity: 'TDSI', settlementLocation: 'CDS',
    quantity: 40000, price: 158.4, currency: 'CAD', counterparty: 'RBC Dominion Securities Inc.', status: 'AFFIRMED', execTime: '10:08:51',
  },
  {
    tradeId: 'TDS-260515-004201', side: 'BUY', ticker: 'CNR', security: 'Canadian National Railway Co.', exchange: 'TSX', isin: 'CA1363751027',
    client: 'CPP Investments', clientType: 'CA Institutional', bookingEntity: 'TDSI', settlementLocation: 'CDS',
    quantity: 60000, price: 152.15, currency: 'CAD', counterparty: 'Scotia Capital Inc.', status: 'PENDING', execTime: '11:03:29',
  },
  {
    tradeId: 'TDS-260515-004096', side: 'BUY', ticker: 'AAPL', security: 'Apple Inc.', exchange: 'NASDAQ', isin: 'US0378331005',
    client: 'Fidelity Management & Research Co.', clientType: 'US Institutional', bookingEntity: 'TDSUSA', settlementLocation: 'DTC',
    quantity: 50000, price: 212.4, currency: 'USD', counterparty: 'Goldman Sachs & Co. LLC', status: 'RELEASED', execTime: '09:47:02',
  },
  {
    tradeId: 'TDS-260515-004155', side: 'SELL', ticker: 'MSFT', security: 'Microsoft Corp.', exchange: 'NASDAQ', isin: 'US5949181045',
    client: 'T. Rowe Price Associates, Inc.', clientType: 'US Institutional', bookingEntity: 'TDSUSA', settlementLocation: 'DTC',
    quantity: 18000, price: 448.1, currency: 'USD', counterparty: 'Morgan Stanley & Co. LLC', status: 'PENDING', execTime: '10:21:44',
  },
  {
    tradeId: 'TDS-260515-004062', side: 'BUY', ticker: 'RY', security: 'Royal Bank of Canada', exchange: 'TSX', isin: 'CA7800871021',
    client: 'Caisse de dépôt et placement du Québec', clientType: 'CA Institutional', bookingEntity: 'TDSI', settlementLocation: 'CDS',
    quantity: 75000, price: 171.3, currency: 'CAD', counterparty: 'National Bank Financial Inc.', status: 'BREAK', execTime: '09:38:15',
    breakReason: 'SSI mismatch — counterparty CUID does not match standing instructions',
  },
  {
    tradeId: 'TDS-260515-004219', side: 'BUY', ticker: 'SU', security: 'Suncor Energy Inc.', exchange: 'NYSE', isin: 'CA8672241079',
    client: 'BlackRock Financial Management, Inc.', clientType: 'US Institutional', bookingEntity: 'TDSUSA', settlementLocation: 'DTC',
    quantity: 90000, price: 39.86, currency: 'USD', counterparty: 'J.P. Morgan Securities LLC', status: 'AFFIRMED', execTime: '11:16:08',
  },
  {
    tradeId: 'TDS-260515-004238', side: 'SELL', ticker: 'BCE', security: 'BCE Inc.', exchange: 'TSX', isin: 'CA05534B7604',
    client: 'Manulife Investment Management', clientType: 'CA Institutional', bookingEntity: 'TDSI', settlementLocation: 'CDS',
    quantity: 110000, price: 33.74, currency: 'CAD', counterparty: 'CIBC World Markets Inc.', status: 'PENDING', execTime: '11:29:53',
  },
];

function settlementCalendar(trade) {
  return calendarForEntity(trade.bookingEntity);
}

function projectSettleDate(trade) {
  const location = SETTLEMENT_LOCATIONS[trade.settlementLocation];
  return addBusinessDays(BUSINESS_DATE, location.cycleDays, settlementCalendar(trade));
}

function cadNotional(trade) {
  const gross = trade.quantity * trade.price;
  const cad = trade.currency === 'CAD' ? gross : gross * USDCAD;
  return Math.round(cad * 100) / 100;
}

function describeTrade(trade) {
  const entity = BOOKING_ENTITIES[trade.bookingEntity];
  const location = SETTLEMENT_LOCATIONS[trade.settlementLocation];
  return {
    ...trade,
    tradeDate: BUSINESS_DATE,
    settleDate: projectSettleDate(trade),
    bookingEntityName: entity.name,
    settlementLocationName: location.name,
    settlementLocationShort: location.short,
    cadNotional: cadNotional(trade),
    fxRate: trade.currency === 'CAD' ? 1 : USDCAD,
  };
}

function findTrade(tradeId) {
  const trade = TRADES.find((t) => t.tradeId === tradeId);
  if (!trade) {
    const err = new Error(`Trade ${tradeId} not found.`);
    err.name = 'NotFoundError';
    err.code = 'TRADE_NOT_FOUND';
    err.statusCode = 404;
    throw err;
  }
  return trade;
}

function getBlotter() {
  return {
    businessDate: BUSINESS_DATE,
    desk: 'Cash Equities — North America',
    failRateMtd: 1.7,
    trades: TRADES.map(describeTrade),
  };
}

function getTrade(tradeId) {
  return describeTrade(findTrade(tradeId));
}

function buildInstruction(trade) {
  const entity = BOOKING_ENTITIES[trade.bookingEntity];
  return {
    messageType: trade.side === 'BUY' ? 'MT541' : 'MT543',
    senderReference: `SSI${trade.tradeId.replace(/\D/g, '').slice(-10)}`,
    tradeId: trade.tradeId,
    depository: trade.settlementLocation,
    deliveringAgent: trade.side === 'BUY' ? trade.counterparty : entity.name,
    receivingAgent: trade.side === 'BUY' ? entity.name : trade.counterparty,
    isin: trade.isin,
    quantity: trade.quantity,
    settlementAmount: Math.round(trade.quantity * trade.price * 100) / 100,
    currency: trade.currency,
    tradeDate: BUSINESS_DATE,
    settleDate: projectSettleDate(trade),
  };
}

function assertReleasable(trade) {
  if (trade.status === 'RELEASED') {
    const err = new Error(`Settlement instructions for ${trade.tradeId} were already released.`);
    err.name = 'ValidationError';
    err.code = 'ALREADY_RELEASED';
    err.statusCode = 409;
    throw err;
  }
  if (trade.status === 'BREAK') {
    const err = new Error(`Trade ${trade.tradeId} has an open settlement break: ${trade.breakReason}.`);
    err.name = 'ValidationError';
    err.code = 'OPEN_BREAK';
    err.statusCode = 409;
    throw err;
  }
}

async function releaseInstructions(data) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const trade = findTrade(data.tradeId);
  assertReleasable(trade);

  logger.info('Releasing settlement instructions', {
    requestId, tradeId: trade.tradeId, bookingEntity: trade.bookingEntity,
    settlementLocation: trade.settlementLocation, service: SERVICE, route: ROUTE,
  });

  let instruction;
  try {
    await new Promise((resolve) => setTimeout(resolve, 250 + Math.random() * 250));
    instruction = buildInstruction(trade);
    const ack = submitInstruction(instruction);

    const duration = Date.now() - startTime;
    incrementMetric('ssi_release.success', { route: ROUTE, service: SERVICE, depository: trade.settlementLocation });
    recordTiming('ssi_release.latency', duration, { route: ROUTE });
    logger.info('Settlement instructions released', {
      requestId, tradeId: trade.tradeId, reference: ack.reference, settleDate: ack.settleDate, durationMs: duration,
    });

    return {
      tradeId: trade.tradeId,
      status: 'RELEASED',
      depository: ack.depository,
      reference: ack.reference,
      settleDate: ack.settleDate,
      messageType: instruction.messageType,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('ssi_release.failure', {
      route: ROUTE, service: SERVICE, depository: trade.settlementLocation, errorClass: error.name,
    });
    recordTiming('ssi_release.latency', duration, { route: ROUTE, error: 'true' });
    logger.error('Settlement instruction release failed', {
      requestId, tradeId: trade.tradeId, error: error.message, errorClass: error.name,
      details: error.details, durationMs: duration, service: SERVICE,
    });

    error.requestId = requestId;
    error.tradeStatus = 'REJECTED';
    if (!error.statusCode) error.statusCode = 500;

    const context = {
      requestId,
      tradeId: trade.tradeId,
      ticker: trade.ticker,
      client: trade.client,
      bookingEntity: BOOKING_ENTITIES[trade.bookingEntity].name,
      settlementLocation: SETTLEMENT_LOCATIONS[trade.settlementLocation].name,
      tradeDate: BUSINESS_DATE,
      settleDate: instruction ? instruction.settleDate : null,
      details: error.details,
    };

    Sentry.captureException(error, {
      tags: {
        route: ROUTE, service: SERVICE, customer: '87575bac', depository: trade.settlementLocation, alert_path: 'instant',
      },
      extra: context,
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/87575bac.js — releaseInstructions',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      customer: '87575bac',
      slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      service: SERVICE,
      verticalLabel: 'TD Securities — Settlement Operations',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'depository', value: trade.settlementLocation },
        { key: 'booking_entity', value: trade.bookingEntity },
        { key: 'trade_id', value: trade.tradeId },
      ],
      extra: {
        ...context,
        promptContext: 'Settlement operations at TD Securities cannot release settlement instructions for this trade: the depository rejects the instruction and the trade flips to REJECTED, putting it at risk of failing to settle.',
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
      promptAppendix: 'When you fix this, add regression tests that project settle dates and release instructions for every trade on the blotter, and record a browser video of /87575bac showing the ENB trade releasing successfully.',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session', { error: err.message, requestId });
    });

    throw error;
  }
}

module.exports = {
  TRADES,
  BUSINESS_DATE,
  getBlotter,
  getTrade,
  releaseInstructions,
  projectSettleDate,
  buildInstruction,
};
