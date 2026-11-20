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
const FEEDBACK_ROUTE = `${API_BASE}/feedback`;
const SERVICE = `customer-${CUSTOMER}-auctions`;
const PAGE_PATH = `/${CUSTOMER}`;
const SCENARIO = 'auction-bid-rejected';
const BID_ERROR = 'Bid not accepted. Request could not be processed.';
const BID_HOLD_MS = 500;
const INCIDENT_WINDOW_MS = 60 * 1000;
const BID_WINDOW_MINUTES = 12;
const MIN_BID_MN = 1;

const ONCALL_CHANNEL = { id: 'C0CKXTAMWQY', name: '#bloomberg-oncall' };
// Support tickets go to #bloomberg-feedback and never page anyone.
const FEEDBACK_CHANNEL = { id: 'C0CK7T5DD3N', label: '#bloomberg-feedback', envVar: 'SLACK_BLOOMBERG_FEEDBACK_CHANNEL_ID' };
const FEEDBACK_LIMIT = { max: 5, windowMs: 60 * 1000 };
const FEEDBACK_CATEGORIES = ['Bid submission', 'Auction calendar', 'Results and allocations', 'Access and entitlements', 'Other'];
const DISCLAIMER = 'This is not a Bloomberg product. Internal demonstration only; no real auctions, bids or market data.';
const OWNER = { slackMemberId: 'U0AS6QZDFD0', email: 'wes.convery@cognition.ai' };

/** Release flags as rolled out to prod by the auction-gateway release pipeline. */
const FLAGS = { 'auctions.bid-limits-v2': true };

const RESPONDER_NOTES = [
  'Repo: https://github.com/COG-GTM/event-driven-devin',
  `Code path: app/services/verticals/${CUSTOMER}.js (submitBid \u2192 limitsFor); page ${PAGE_PATH} (alias /bloomberg-auctions) \u2192 Submit bid.`,
  'Feature flag: auctions.bid-limits-v2 (bloomberg-feature-flag MCP).',
].join('\n');

const DEALER = { name: 'Meridian Capital Markets', role: 'Gilt-edged Market Maker', user: 'AMORGAN', firmId: 'MCMK' };

const DMO = 'UK Debt Management Office';
/** ISO date `offset` business days from today (weekends skipped; today counts if it is a weekday). */
function day(offset) {
  const date = new Date();
  const step = offset < 0 ? -1 : 1;
  const weekend = () => date.getUTCDay() === 0 || date.getUTCDay() === 6;
  while (weekend()) date.setUTCDate(date.getUTCDate() + step);
  for (let left = Math.abs(offset); left > 0;) {
    date.setUTCDate(date.getUTCDate() + step);
    if (!weekend()) left -= 1;
  }
  return date.toISOString().slice(0, 10);
}

/** Today's auction is open for bidding; the rest of the calendar is announced but not yet open. */
const AUCTIONS = [
  { auctionId: 'UKT-4Q34', status: 'OPEN', issuer: 'UKT', issuerName: DMO, security: 'UKT 4 1/4 07/31/34', name: '4\u00bc% Treasury Gilt 2034', isin: 'GB00BPCJD880', coupon: 4.25, maturity: '2034-07-31', sizeMn: 4000, currency: 'GBP', indicativeYield: 4.412, wiBid: 4.417, wiAsk: 4.407, auctionDate: day(0), settlement: day(1), format: 'Competitive, multiple price', previous: { date: day(-35), cover: 3.04, avgYield: 4.386, tailBp: 0.4 } },
  { auctionId: 'UKT-4H30', status: 'ANNOUNCED', issuer: 'UKT', issuerName: DMO, security: 'UKT 4 3/8 03/07/30', name: '4\u215c% Treasury Gilt 2030', isin: 'GB00BQC82C90', coupon: 4.375, maturity: '2030-03-07', sizeMn: 4500, currency: 'GBP', indicativeYield: 3.941, wiBid: 3.946, wiAsk: 3.936, auctionDate: day(2), settlement: day(3), format: 'Competitive, multiple price', previous: { date: day(-28), cover: 3.31, avgYield: 3.902, tailBp: 0.2 } },
  { auctionId: 'UKT-1Q54', status: 'ANNOUNCED', issuer: 'UKT', issuerName: DMO, security: 'UKT 4 3/8 07/31/54', name: '4\u215c% Treasury Gilt 2054', isin: 'GB00BPSNBB36', coupon: 4.375, maturity: '2054-07-31', sizeMn: 2250, currency: 'GBP', indicativeYield: 4.957, wiBid: 4.963, wiAsk: 4.951, auctionDate: day(7), settlement: day(8), format: 'Competitive, multiple price', previous: { date: day(-49), cover: 2.87, avgYield: 4.921, tailBp: 0.9 } },
];

/** Recently closed auctions, shown on the calendar with their published results. */
const RESULTS = [
  { auctionId: 'UKT-3T28', security: 'UKT 3 3/4 03/07/28', date: day(-2), sizeMn: 4750, cover: 3.18, avgYield: 3.702, tailBp: 0.3, allocatedMn: 212.5 },
  { auctionId: 'UKTI-1Q36', security: 'UKTI 1 1/8 09/22/36', date: day(-7), sizeMn: 1600, cover: 3.42, avgYield: 1.214, tailBp: 0.6, allocatedMn: 64 },
  { auctionId: 'UKT-4H44', security: 'UKT 4 1/2 12/07/44', date: day(-9), sizeMn: 2750, cover: 2.94, avgYield: 4.873, tailBp: 1.1, allocatedMn: 118 },
];

const openAuctions = () => AUCTIONS.filter((auction) => auction.status === 'OPEN');
const sizeOf = (list) => list.reduce((sum, auction) => sum + auction.sizeMn, 0);

/** v1 limits: per-ISIN dealer bid limits (nominal, millions). */
const BID_LIMITS = {
  GB00BPCJD880: { maxBidMn: 1000, minYield: 3.5, maxYield: 5.5 },
  GB00BQC82C90: { maxBidMn: 1100, minYield: 3.0, maxYield: 5.0 },
  GB00BPSNBB36: { maxBidMn: 560, minYield: 4.0, maxYield: 6.0 },
};

/** v2 limits: per issuer and maturity bucket (auction-gateway 2026.11.3). */
const BID_LIMITS_V2 = {
  'UKT:10Y': { maxBidMn: 1000, yieldBand: { min: 3.5, max: 5.5 } },
  'UKT:5Y': { maxBidMn: 1100, yieldBand: { min: 3.0, max: 5.0 } },
  'UKT:30Y': { maxBidMn: 560, yieldBand: { min: 4.0, max: 6.0 } },
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
    auctions: AUCTIONS.map((auction) => ({ ...auction, cutoff: auction.status === 'OPEN' ? cutoff : null, maxBidMn: BID_LIMITS[auction.isin].maxBidMn })),
    results: RESULTS.map((result) => ({ ...result })),
    bids: bids.map((bid) => ({ ...bid })),
    summary: { open: openAuctions().length, totalSizeMn: sizeOf(openAuctions()), bidsAccepted: bids.length },
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
    auctionsOpen: openAuctions().length,
    auctionSizeAtRiskMn: sizeOf(openAuctions()),
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
  if (auction.status !== 'OPEN') throw validationError('Bidding is not open for this auction', 'AUCTION_NOT_OPEN');
  const nominalMn = input.nominalMn;
  const yieldPct = input.yieldPct;
  if (!(Number.isFinite(nominalMn) && nominalMn >= MIN_BID_MN)) throw validationError(`Nominal must be at least ${MIN_BID_MN}mn`, 'INVALID_NOMINAL');
  if (!(Number.isFinite(yieldPct) && yieldPct > 0)) throw validationError('Enter a bid yield', 'INVALID_YIELD');
  if (!Number.isInteger(nominalMn)) throw validationError('Nominal must be in whole millions', 'INVALID_INCREMENT');
  if (Math.abs(yieldPct * 1000 - Math.round(yieldPct * 1000)) > 1e-6) throw validationError('Yield must be in increments of 0.001%', 'INVALID_INCREMENT');
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
  const used = bids.filter((item) => item.auctionId === auction.auctionId).reduce((sum, item) => sum + item.nominalMn, 0);
  if (used + nominalMn > limits.maxBidMn) throw validationError(`Bid exceeds your limit of ${limits.maxBidMn}mn (${limits.maxBidMn - used}mn remaining)`, 'OVER_LIMIT');
  if (yieldPct < limits.minYield || yieldPct > limits.maxYield) throw validationError(`Yield must be between ${limits.minYield}% and ${limits.maxYield}%`, 'YIELD_OUT_OF_BAND');

  const accepted = { bidId: `BID-${uuidv4().slice(0, 8).toUpperCase()}`, auctionId: auction.auctionId, security: auction.security, nominalMn, yieldPct, currency: auction.currency, status: 'ACCEPTED', user: DEALER.user, at: new Date().toISOString() };
  bids.push(accepted);
  incrementMetric('auctions.bid.success', { route: ROUTE, customer: CUSTOMER });
  recordTiming('auctions.bid.latency', Date.now() - startTime, { route: ROUTE });
  return { ...accepted, requestId, demo: true };
}

/* Contact Support -> support ticket -> #bloomberg-feedback */

const feedbackWindow = [];
function resetFeedbackState() { feedbackWindow.length = 0; }

function feedbackError(message, statusCode = 400) {
  const error = new Error(message);
  error.name = 'FeedbackError';
  error.code = 'FEEDBACK_REJECTED';
  error.statusCode = statusCode;
  return error;
}

function reserveFeedbackSlot(now = Date.now()) {
  while (feedbackWindow.length && now - feedbackWindow[0] >= FEEDBACK_LIMIT.windowMs) feedbackWindow.shift();
  if (feedbackWindow.length >= FEEDBACK_LIMIT.max) return false;
  feedbackWindow.push(now);
  return true;
}

const clip = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

async function submitFeedback(input = {}) {
  const title = clip(input.title, 200);
  const description = clip(input.description, 4000);
  const { category, page, reference } = input;
  if (!FEEDBACK_CATEGORIES.includes(category)) throw feedbackError('Choose a category.');
  if (title.length < 3 || title.length > 120) throw feedbackError('Enter a summary between 3 and 120 characters.');
  if (description.length < 10 || description.length > 2000) throw feedbackError('Describe the problem in 10 to 2,000 characters.');
  if (typeof page !== 'string' || page.length > 200 || !/^\/[a-zA-Z0-9/_-]*$/.test(page)) {
    throw feedbackError('Report the problem from a valid page in this demo.');
  }
  if (reference != null && reference !== '' && !/^[A-Za-z0-9-]{1,40}$/.test(reference)) {
    throw feedbackError('Reference is not valid.');
  }
  const ticketId = `SUP-${uuidv4().slice(0, 8).toUpperCase()}`;
  const token = slackToken();
  if (!token) {
    logger.warn('Auction support ticket not sent \u2014 no Slack bot token configured', { route: FEEDBACK_ROUTE });
    return { status: 'dry-run', channel: FEEDBACK_CHANNEL.label, ticketId };
  }
  if (!reserveFeedbackSlot()) throw feedbackError('Too many tickets. Please wait a minute before trying again.', 429);
  const channel = (process.env[FEEDBACK_CHANNEL.envVar] || FEEDBACK_CHANNEL.id).trim();
  if (channel === ONCALL_CHANNEL.id) {
    logger.error('Auction feedback channel must not be the on-call channel', { route: FEEDBACK_ROUTE });
    throw feedbackError(`Support is not connected to ${FEEDBACK_CHANNEL.label} on this server.`, 503);
  }
  const context = [`Ticket ${ticketId}`, category, `${DEALER.name} (${DEALER.firmId}) \u00b7 ${DEALER.user}`, `Page: ${page}`];
  if (reference) context.push(`Reference: ${reference}`);
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Auction System demo \u2014 Support ticket' } },
    { type: 'section', text: { type: 'plain_text', text: title } },
    { type: 'section', text: { type: 'plain_text', text: description } },
    { type: 'context', elements: [{ type: 'plain_text', text: `${context.join(' \u00b7 ')} \u00b7 Internal demonstration` }] },
  ];
  try {
    // Fallback text is fixed: reporter text only ever travels in plain_text blocks.
    const ts = await postJoining(token, channel, 'Auction System demo \u2014 new support ticket', blocks);
    logger.info('Auction support ticket posted', { channel, ts, ticketId, route: FEEDBACK_ROUTE });
  } catch (error) {
    logger.error('Auction support ticket failed', { error: error.message, route: FEEDBACK_ROUTE });
    throw feedbackError(`Unable to confirm delivery. Check ${FEEDBACK_CHANNEL.label} before retrying.`, 502);
  }
  incrementMetric('auctions.feedback.sent', { route: FEEDBACK_ROUTE, customer: CUSTOMER });
  return { status: 'sent', channel: FEEDBACK_CHANNEL.label, ticketId };
}

function publicConfig() {
  return {
    mode: 'live', scenario: SCENARIO, disclaimer: DISCLAIMER, channel: ONCALL_CHANNEL.name,
    feedbackChannel: FEEDBACK_CHANNEL.label, feedbackMode: slackToken() ? 'live' : 'dry-run', feedbackCategories: FEEDBACK_CATEGORIES,
  };
}

module.exports = {
  CUSTOMER, API_BASE, ROUTE, FEEDBACK_ROUTE, FEEDBACK_CHANNEL, FEEDBACK_CATEGORIES, SERVICE, PAGE_PATH, SCENARIO, BID_ERROR, ONCALL_CHANNEL, OWNER, RESPONDER_NOTES,
  FLAGS, AUCTIONS, RESULTS, BID_LIMITS, BID_LIMITS_V2,
  getAuctions, limitsFor, submitBid, publicConfig, resetBids, resetIncidentWindow,
  submitFeedback, resetFeedbackState,
};
