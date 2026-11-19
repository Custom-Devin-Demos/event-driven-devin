const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const {
  postMessage, joinChannel, buildAlertBlocks, buildAlertText, resolveOnCallMember,
} = require('../slack');
const { getCustomerConfig } = require('../../../config/customers');

/**
 * Bloomberg Auction System look-alike (page app/public/verticals/5e2f9a41.html):
 * a primary dealer's web bidding page for government bond auctions. The page
 * lists today's auctions and submits bids through /api/5e2f9a41/bids. Bid
 * submission is the on-call trigger; the calendar stays healthy.
 */
const CUSTOMER = '5e2f9a41';
const API_BASE = `/api/${CUSTOMER}`;
const ROUTE = `${API_BASE}/bids`;
const SERVICE = `customer-${CUSTOMER}-auctions`;
const PAGE_PATH = `/${CUSTOMER}`;
const SCENARIO = 'auction-bid-rejected';
const BID_ERROR = 'Bid not accepted. Request could not be processed.';
const BID_HOLD_MS = 500;
const INCIDENT_WINDOW_MS = 60 * 1000;
const BID_WINDOW_MINUTES = 12;
const MIN_BID_MN = 1;

const ONCALL_CHANNEL = { id: 'C0CKXTAMWQY', name: '#bloomberg-oncall' };
const DISCLAIMER = 'This is not a Bloomberg product. Internal demonstration only; no real auctions, bids or market data.';
const OWNER = { slackMemberId: 'U0AS6QZDFD0', email: 'wes.convery@cognition.ai' };

/** Release flags as rolled out to prod by the auction-gateway release pipeline. */
const FLAGS = { 'auctions.bid-limits-v2': true };

const RESPONDER_NOTES = [
  'Repo: https://github.com/COG-GTM/event-driven-devin',
  `Code path: app/services/verticals/${CUSTOMER}.js (submitBid \u2192 limitsFor); page ${PAGE_PATH} (alias /bloomberg-auctions) \u2192 Submit bid.`,
  'Feature flag: auctions.bid-limits-v2 (bloomberg-feature-flag MCP).',
].join('\n');

const DEALER = { name: 'Meridian Capital Markets', role: 'Primary dealer (GEMM)', user: 'AMORGAN' };

const AUCTIONS = [
  { auctionId: 'UKT-4Q34', issuer: 'UKT', issuerName: 'UK Debt Management Office', security: 'UKT 4 1/4 07/31/34', isin: 'GB00BPCJD880', maturity: '2034-07-31', sizeMn: 4000, currency: 'GBP', indicativeYield: 4.412 },
  { auctionId: 'UKT-1Q54', issuer: 'UKT', issuerName: 'UK Debt Management Office', security: 'UKT 4 3/8 07/31/54', isin: 'GB00BPSNBB36', maturity: '2054-07-31', sizeMn: 2250, currency: 'GBP', indicativeYield: 4.957 },
  { auctionId: 'DBR-2Q35', issuer: 'DBR', issuerName: 'German Finance Agency', security: 'DBR 2.6 08/15/35', isin: 'DE000BU2Z056', maturity: '2035-08-15', sizeMn: 4500, currency: 'EUR', indicativeYield: 2.684 },
];

/** v1 limits: per-ISIN dealer bid limits (nominal, millions). */
const BID_LIMITS = {
  GB00BPCJD880: { maxBidMn: 1000, minYield: 3.5, maxYield: 5.5 },
  GB00BPSNBB36: { maxBidMn: 560, minYield: 4.0, maxYield: 6.0 },
  DE000BU2Z056: { maxBidMn: 1100, minYield: 1.8, maxYield: 3.6 },
};

/** v2 limits: per issuer and maturity bucket (auction-gateway 2026.11.3). */
const BID_LIMITS_V2 = {
  'UKT:10Y': { maxBidMn: 1000, yieldBand: { min: 3.5, max: 5.5 } },
  'UKT:30Y': { maxBidMn: 560, yieldBand: { min: 4.0, max: 6.0 } },
  'DBR:10Y': { maxBidMn: 1100, yieldBand: { min: 1.8, max: 3.6 } },
};

const openedAt = Date.now();
let bids = [];
let lastIncidentAt = 0;

function resetBids() { bids = []; }
function resetIncidentWindow() { lastIncidentAt = 0; }

function validationError(message, code) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = 400;
  return error;
}

/** The demo window always has BID_WINDOW_MINUTES left on a rolling clock. */
function cutoffFor(now = Date.now()) {
  const windowMs = BID_WINDOW_MINUTES * 60 * 1000;
  return new Date(openedAt + (Math.floor((now - openedAt) / windowMs) + 1) * windowMs).toISOString();
}

function getAuctions() {
  const cutoff = cutoffFor();
  return {
    dealer: { ...DEALER },
    auctions: AUCTIONS.map((auction) => ({ ...auction, status: 'BIDDING OPEN', cutoff, maxBidMn: BID_LIMITS[auction.isin].maxBidMn })),
    bids: bids.map((bid) => ({ ...bid })),
    summary: { open: AUCTIONS.length, totalSizeMn: AUCTIONS.reduce((sum, auction) => sum + auction.sizeMn, 0), bidsAccepted: bids.length },
  };
}

function maturityBucket(auction) {
  const years = Math.round((new Date(auction.maturity) - Date.now()) / (365.25 * 24 * 3600 * 1000));
  return `${years}Y`;
}

function limitsFor(auction) {
  if (FLAGS['auctions.bid-limits-v2']) {
    const limits = BID_LIMITS_V2[`${auction.issuer}:${maturityBucket(auction)}`];
    return { maxBidMn: limits.maxBidMn, minYield: limits.yieldBand.min, maxYield: limits.yieldBand.max };
  }
  return BID_LIMITS[auction.isin];
}

function slackToken(env = process.env) {
  return env.SLACK_ONCALL_BOT_TOKEN || env.SLACK_BOT_TOKEN || '';
}

/** Post once; if the bot is not yet in the (public) channel, join and retry once. */
async function postJoining(token, channel, messageText, blocks) {
  try {
    return await postMessage(token, channel, messageText, blocks);
  } catch (error) {
    if (!/not_in_channel/.test(error.message || '')) throw error;
    await joinChannel(token, channel);
    return postMessage(token, channel, messageText, blocks);
  }
}

/**
 * Post the alert card to #bloomberg-oncall only (the customer's
 * slackChannelId, never the shared SLACK_CHANNEL_ID) without the "Devin AI
 * (auto-investigating)" line: the channel's responder decides what to do.
 */
async function postAlertCard(alertData, requestId) {
  const token = slackToken();
  const channel = alertData.customerConfig.slackChannelId;
  if (!token || !channel) {
    logger.warn('Slack not configured \u2014 skipping auction bid alert post', { requestId });
    return null;
  }
  await resolveOnCallMember(alertData);
  const messageText = `${buildAlertText(alertData)}\n${RESPONDER_NOTES}`;
  const blocks = [
    ...buildAlertBlocks(alertData, { includeDevinOnCall: false }),
    { type: 'context', elements: [{ type: 'mrkdwn', text: RESPONDER_NOTES }] },
  ];
  const ts = await postJoining(token, channel, messageText, blocks);
  logger.info('auction bid alert posted', { channel, ts, requestId });
  return { ok: true, channel, ts };
}

function raiseIncident(error, auction, bid, requestId) {
  const now = Date.now();
  if (now - lastIncidentAt < INCIDENT_WINDOW_MS) {
    logger.info('Auction bid failure joined the open incident', { requestId, scenario: SCENARIO });
    return Promise.resolve(null);
  }
  lastIncidentAt = now;
  const reopenWindow = () => { if (lastIncidentAt === now) lastIncidentAt = 0; };

  const tags = { route: ROUTE, service: SERVICE, step: 'bid-limits', scenario: SCENARIO, issuer: auction.issuer, flag: 'auctions.bid-limits-v2' };
  const extra = {
    requestId,
    auctionId: auction.auctionId,
    security: auction.security,
    bidNominalMn: bid.nominalMn,
    currency: auction.currency,
    auctionsOpen: AUCTIONS.length,
    auctionSizeAtRiskMn: AUCTIONS.reduce((sum, item) => sum + item.sizeMn, 0),
    bidsAcceptedThisWindow: bids.length,
    cutoff: cutoffFor(now),
  };

  Sentry.captureException(error, { tags: { ...tags, alert_path: 'instant' }, extra });

  const alertData = {
    issueTitle: `${error.name}: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: `app/services/verticals/${CUSTOMER}.js \u2014 limitsFor`,
    errorType: error.name || 'Error',
    errorValue: error.message,
    devinEmail: OWNER.email,
    slackMemberIdFallback: OWNER.slackMemberId,
    service: SERVICE,
    verticalLabel: 'Bloomberg Auction System \u2014 bid submission',
    customer: CUSTOMER,
    customerConfig: getCustomerConfig(CUSTOMER),
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    extra,
    level: 'error',
    platform: 'node',
    firstSeen: '',
    lastSeen: new Date().toISOString(),
    count: '',
    shortId: '',
    project: 'event-driven-devin',
    release: process.env.SENTRY_RELEASE || 'auction-gateway@2026.11.3',
    environment: process.env.DD_ENV || 'prod',
    triggeredRule: '',
  };

  return postAlertCard(alertData, requestId)
    .then((result) => { if (!result) reopenWindow(); return result; })
    .catch((alertError) => {
      logger.error('Failed to post auction bid alert', { error: alertError.message, requestId });
      reopenWindow();
      return null;
    });
}

/**
 * Submit a competitive bid: validate the ticket, hold for the dealer
 * entitlement round trip, then check it against the dealer's bid limits. A
 * failure is captured to Sentry and posted as a #bloomberg-oncall alert card
 * before it is rethrown; no bid is recorded.
 */
async function submitBid(data, { hold = BID_HOLD_MS } = {}) {
  const startTime = Date.now();
  const requestId = `AUC-${uuidv4().slice(0, 8).toUpperCase()}`;
  const input = data || {};
  const auction = AUCTIONS.find((item) => item.auctionId === String(input.auctionId || '').toUpperCase());
  if (!auction) throw validationError('Unknown auction', 'UNKNOWN_AUCTION');
  const nominalMn = input.nominalMn;
  const yieldPct = input.yieldPct;
  if (!(Number.isFinite(nominalMn) && nominalMn >= MIN_BID_MN)) throw validationError(`Nominal must be at least ${MIN_BID_MN}mn`, 'INVALID_NOMINAL');
  if (!(Number.isFinite(yieldPct) && yieldPct > 0)) throw validationError('Enter a bid yield', 'INVALID_YIELD');
  const bid = { nominalMn, yieldPct };

  logger.info('Auction bid request', { requestId, auctionId: auction.auctionId, nominalMn, service: SERVICE, route: ROUTE });

  let limits;
  try {
    await new Promise((resolve) => setTimeout(resolve, hold));
    limits = limitsFor(auction);
  } catch (error) {
    incrementMetric('auctions.bid.failure', { route: ROUTE, customer: CUSTOMER, errorClass: error.name });
    recordTiming('auctions.bid.latency', Date.now() - startTime, { route: ROUTE, error: 'true' });
    logger.error('Auction bid failed', { requestId, auctionId: auction.auctionId, nominalMn, error: error.message, errorClass: error.name, service: SERVICE });
    error.alertPromise = raiseIncident(error, auction, bid, requestId);
    error.requestId = requestId;
    error.code = 'BID_UNAVAILABLE';
    error.statusCode = 503;
    error.publicMessage = BID_ERROR;
    throw error;
  }
  if (nominalMn > limits.maxBidMn) throw validationError(`Bid exceeds your limit of ${limits.maxBidMn}mn`, 'OVER_LIMIT');
  if (yieldPct < limits.minYield || yieldPct > limits.maxYield) throw validationError(`Yield must be between ${limits.minYield}% and ${limits.maxYield}%`, 'YIELD_OUT_OF_BAND');

  const accepted = { bidId: `BID-${uuidv4().slice(0, 8).toUpperCase()}`, auctionId: auction.auctionId, security: auction.security, nominalMn, yieldPct, currency: auction.currency, status: 'ACCEPTED', at: new Date().toISOString() };
  bids.push(accepted);
  incrementMetric('auctions.bid.success', { route: ROUTE, customer: CUSTOMER });
  recordTiming('auctions.bid.latency', Date.now() - startTime, { route: ROUTE });
  return { ...accepted, requestId, demo: true };
}

function publicConfig() {
  return { mode: 'live', scenario: SCENARIO, disclaimer: DISCLAIMER, channel: ONCALL_CHANNEL.name };
}

module.exports = {
  CUSTOMER, API_BASE, ROUTE, SERVICE, PAGE_PATH, SCENARIO, BID_ERROR, ONCALL_CHANNEL, OWNER, RESPONDER_NOTES,
  FLAGS, AUCTIONS, BID_LIMITS, BID_LIMITS_V2,
  getAuctions, limitsFor, submitBid, publicConfig, resetBids, resetIncidentWindow,
};
