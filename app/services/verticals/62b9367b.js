const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { listOrgUsers, listEnterpriseAdmins } = require('../devin-api');
const { getCustomerConfig } = require('../../../config/customers');

const CUSTOMER = '62b9367b';
const ROUTE = '/api/62b9367b/portfolios/:portfolioId';
const SERVICE = 'assetcentral-portfolio-api';
const RELEASE = 'assetcentral-portfolio-api@3.18.2';
const ALERT_COOLDOWN_MS = Number(process.env.ALERT_COOLDOWN_MS_62B9367B) || 10 * 60 * 1000;
// Round trip to the valuation service for one holding's mark.
const MARK_LOOKUP_MS = Number(process.env.VALUATION_LOOKUP_MS_62B9367B) || 240;
const VALUATION_DEADLINE_MS = 9000;
const SLACK_MEMBER_ID_FALLBACK = process.env.ASSETCENTRAL_SLACK_MEMBER_ID || '';
// Branch the investigation starts from and targets; override while the skin is unmerged.
const SOURCE_BRANCH = process.env.ASSETCENTRAL_SOURCE_BRANCH || 'main';
const ESG_AS_OF_MONTH = 'Sep 2026';
const CORPORATE_PORTFOLIO_ID = 'PRE-CORP-S1';
const SIGNED_IN_ANALYST = 'A. Rivera';

function holding(assetId, asset, propertyType, market, marketValue, emissionsTco2e, revenueUsdM) {
  return { assetId, asset, propertyType, market, marketValue, emissionsTco2e, revenueUsdM };
}

const SEED_PORTFOLIOS = [
  {
    id: 'PRE-USCORE',
    name: 'US Core Property Fund',
    strategy: 'Core',
    region: 'United States',
    manager: 'M. Okafor',
    holdings: [
      holding('AC-10021', 'Harbor Point Logistics Center', 'Industrial', 'Newark, NJ', 312400000, 1840, 21.6),
      holding('AC-10034', 'The Lindley at Uptown', 'Multifamily', 'Dallas, TX', 228750000, 2310, 17.9),
      holding('AC-10047', 'Cedar Commons', 'Retail', 'Atlanta, GA', 96300000, 1120, 9.4),
      holding('AC-10052', '1400 Mission Street', 'Office', 'San Francisco, CA', 184500000, 2980, 15.2),
      holding('AC-10068', 'Riverside Innovation Campus', 'Life Science', 'Cambridge, MA', 268900000, 4120, 22.8),
      holding('AC-10071', 'Gateway Self Storage Portfolio', 'Self Storage', 'Phoenix, AZ', 74200000, 390, 8.1),
      holding('AC-10085', 'Westshore Distribution Park', 'Industrial', 'Tampa, FL', 141600000, 960, 11.3),
      holding('AC-10093', 'Alder Row Apartments', 'Multifamily', 'Denver, CO', 119800000, null, 9.7),
      holding('AC-10104', 'Northlake Data Hall 2', 'Data Center', 'Chicago, IL', 205300000, 9640, 26.4),
      holding('AC-10117', 'Brookfield Corners', 'Retail', 'Charlotte, NC', 58900000, 710, 6.2),
    ],
  },
  {
    id: 'PRE-EUVA3',
    name: 'European Value-Add Fund III',
    strategy: 'Value-Add',
    region: 'Europe',
    manager: 'C. Lindqvist',
    holdings: [
      holding('AC-20011', 'Kanaalpark Logistics', 'Industrial', 'Rotterdam, NL', 88400000, 610, 6.9),
      holding('AC-20026', 'Maison Haussmann 42', 'Office', 'Paris, FR', 142700000, 1290, 10.8),
      holding('AC-20038', 'Isar Wohnen', 'Multifamily', 'Munich, DE', 101200000, 980, 7.4),
      holding('AC-20043', 'Calle Serrano Retail', 'Retail', 'Madrid, ES', 63500000, 540, 5.1),
      holding('AC-20057', 'Docklands Studio Lofts', 'Student Housing', 'Dublin, IE', 77900000, null, 6.6),
      holding('AC-20064', 'Porta Nuova Hotel', 'Hotel', 'Milan, IT', 92600000, 2140, 13.5),
      holding('AC-20072', 'Vasa Kontor', 'Office', 'Stockholm, SE', 58300000, 310, 4.7),
    ],
  },
  {
    id: 'PRE-APLOG',
    name: 'Asia Pacific Logistics Partners',
    strategy: 'Core-Plus',
    region: 'Asia Pacific',
    manager: 'H. Tanaka',
    holdings: [
      holding('AC-30015', 'Sagamihara Distribution Center', 'Industrial', 'Kanagawa, JP', 166200000, 1420, 12.2),
      holding('AC-30022', 'Tuas Cold Store', 'Industrial', 'Singapore, SG', 94800000, 2260, 9.8),
      holding('AC-30039', 'Moorebank Freight Hub', 'Industrial', 'Sydney, AU', 128500000, 870, 10.1),
      holding('AC-30046', 'Incheon Gateway Logistics', 'Industrial', 'Incheon, KR', 83100000, 1190, 7.6),
      holding('AC-30051', 'Osaka Bay Last Mile', 'Industrial', 'Osaka, JP', 57400000, null, 4.9),
    ],
  },
  {
    id: CORPORATE_PORTFOLIO_ID,
    name: 'Sample Corporate Portfolio',
    strategy: 'Listed Real Estate Securities',
    region: 'Global',
    manager: 'R. Desai',
    holdings: [
      holding('AC-CS-0101', 'Meridian Industrial REIT', 'Industrial', 'NYSE', 48200000, 41200, 1380),
      holding('AC-CS-0108', 'Crestline Residential Trust', 'Multifamily', 'NYSE', 39700000, 58800, 1520),
      holding('AC-CS-0115', 'Halcyon Office Properties', 'Office', 'NYSE', 21400000, 66100, 980),
      holding('AC-CS-0122', 'Blue Harbor Data Centers', 'Data Center', 'NASDAQ', 44900000, 412000, 3460),
      holding('AC-CS-0129', 'Ashford Self Storage', 'Self Storage', 'NYSE', 18300000, 9800, 640),
      holding('AC-CS-0136', 'Kestrel Retail Partners', 'Retail', 'NYSE', 16800000, 37400, 1110),
      holding('AC-CS-0143', 'Northwind Life Science Realty', 'Life Science', 'NYSE', 27500000, 52300, 890),
      holding('AC-CS-0150', 'Solace Senior Living', 'Senior Housing', 'NYSE', 14900000, 71900, 1740),
      holding('AC-CS-0157', 'Tidewater Logistics Trust', 'Industrial', 'LSE', 22600000, 18700, 720),
      holding('AC-CS-0164', 'Rhein Wohnen AG', 'Multifamily', 'XETRA', 19800000, 44600, 1290),
      holding('AC-CS-0171', 'Sakura Office REIT', 'Office', 'TSE', 15200000, 23800, 610),
      holding('AC-CS-0178', 'Pacific Towers Income Fund', 'Office', 'ASX', 12700000, null, 540),
      holding('AC-CS-0185', 'Lumen Hospitality Group', 'Hotel', 'NYSE', 10900000, 88200, 2050),
      holding('AC-CS-0192', 'Granite Peak Storage', 'Self Storage', 'NYSE', 9600000, 6100, 410),
      holding('AC-CS-0199', 'Vireo Healthcare Properties', 'Senior Housing', 'NYSE', 13400000, 49500, 1180),
      holding('AC-CS-0206', 'Atlas Cell Tower Corp', 'Infrastructure', 'NYSE', 25100000, 96400, 4120),
      holding('AC-CS-0213', 'Brightwater Student Living', 'Student Housing', 'LSE', 8700000, 12900, 380),
      holding('AC-CS-0220', 'Orchard Net Lease Trust', 'Retail', 'NYSE', 11300000, 4300, 470),
    ],
  },
];

const SEED_AUDIT = {
  'PRE-USCORE': [
    ['2026-10-02T13:05:00Z', 'esg-feed-loader', 'ESG feed loaded', 'Carbon intensity for Sep 2026 loaded for 10 assets.'],
    ['2026-10-05T15:42:00Z', 'M. Okafor', 'Valuation approved', 'Q3 2026 appraisals approved for 10 assets.'],
  ],
  'PRE-EUVA3': [
    ['2026-10-02T13:06:00Z', 'esg-feed-loader', 'ESG feed loaded', 'Carbon intensity for Sep 2026 loaded for 7 assets.'],
    ['2026-10-14T09:18:00Z', 'C. Lindqvist', 'Holding updated', 'Porta Nuova Hotel reclassified from Mixed Use to Hotel.'],
  ],
  'PRE-APLOG': [
    ['2026-10-02T13:06:00Z', 'esg-feed-loader', 'ESG feed loaded', 'Carbon intensity for Sep 2026 loaded for 5 assets.'],
  ],
  [CORPORATE_PORTFOLIO_ID]: [
    ['2026-10-02T13:07:00Z', 'esg-feed-loader', 'ESG feed loaded', 'Carbon intensity for Sep 2026 loaded for 18 issuers.'],
    ['2026-10-09T18:22:00Z', 'R. Desai', 'Carbon intensity override', 'WACI set to 61.0. Reason: vendor restated Atlas Cell Tower scope 2 for FY2025.'],
    ['2026-10-12T14:01:00Z', 'R. Desai', 'Override cleared', 'Vendor restatement received in the monthly feed.'],
  ],
};

// The position the nightly load picks up for the corporate portfolio: a new
// issue that settled after the pricing vendor's close, so it arrives unpriced.
const NIGHTLY_POSITION = holding('AC-CS-0227', 'Cobalt Bay Logistics REIT', 'Industrial', 'NYSE', null, 15200, 590);
const NIGHTLY_BATCH_ID = 'NPL-20261029-0210';

class Money {
  constructor(cents) {
    this.cents = cents;
  }

  static usd(amount) {
    return new Money(Math.round(amount * 100));
  }

  static zero() {
    return new Money(0);
  }

  add(other) {
    if (!(other instanceof Money)) {
      throw new TypeError(`unsupported operand type(s) for +: 'Money' and '${other === null ? 'null' : typeof other}'`);
    }
    return new Money(this.cents + other.cents);
  }

  ratio(total) {
    return total.cents ? this.cents / total.cents : 0;
  }

  toNumber() {
    return this.cents / 100;
  }
}

function toMoney(value) {
  return typeof value === 'number' ? Money.usd(value) : value;
}

let portfolios = [];
let markStore = new Map();
let snapshotCache = new Map();
let positionsLoaded = false;
let positionsLoadedAt = null;
let lastAlertAt = 0;

function snapshotKey(portfolio) {
  return `${portfolio.id}@${portfolio.positionsVersion}`;
}

function auditEntry(at, actor, action, detail) {
  return { at, actor, action, detail };
}

// Weighted average carbon intensity: each holding's tCO2e per USD m revenue,
// weighted by market value across the holdings that report emissions.
function carbonIntensity(rows) {
  const covered = rows.filter((row) => row.emissionsTco2e != null && row.revenueUsdM > 0);
  const coveredWeight = covered.reduce((sum, row) => sum + row.weight, 0);
  const waci = coveredWeight
    ? covered.reduce((sum, row) => sum + row.weight * (row.emissionsTco2e / row.revenueUsdM), 0) / coveredWeight
    : null;
  return {
    waci: waci == null ? null : Math.round(waci * 10) / 10,
    coveragePct: Math.round(coveredWeight * 1000) / 10,
    asOfMonth: ESG_AS_OF_MONTH,
  };
}

function valueHoldings(holdings, marks) {
  const priced = holdings.map((item, index) => ({ ...item, value: toMoney(marks[index].marketValue) }));
  const total = priced.reduce((sum, item) => sum.add(item.value), Money.zero());
  const rows = priced.map((item) => ({
    assetId: item.assetId,
    asset: item.asset,
    propertyType: item.propertyType,
    market: item.market,
    marketValue: item.value.toNumber(),
    weight: item.value.ratio(total),
    emissionsTco2e: item.emissionsTco2e,
    revenueUsdM: item.revenueUsdM,
  }));
  return {
    totalMarketValue: total.toNumber(),
    holdings: rows,
    carbon: carbonIntensity(rows),
    valuedAt: new Date().toISOString(),
  };
}

// Last close's snapshots are bulk loaded at startup; a positions change
// invalidates a portfolio's snapshot and the next open revalues it.
function resetDemoState() {
  portfolios = SEED_PORTFOLIOS.map((seed) => ({
    ...seed,
    holdings: seed.holdings.map((item) => ({ ...item })),
    positionsVersion: 1,
    carbonOverride: null,
    audit: (SEED_AUDIT[seed.id] || []).map((entry) => auditEntry(...entry)).reverse(),
  }));
  markStore = new Map();
  for (const seed of SEED_PORTFOLIOS) {
    for (const item of seed.holdings) {
      markStore.set(item.assetId, { assetId: item.assetId, marketValue: item.marketValue, source: 'vendor-close' });
    }
  }
  snapshotCache = new Map();
  for (const portfolio of portfolios) {
    const marks = portfolio.holdings.map((item) => markStore.get(item.assetId));
    const snapshot = valueHoldings(portfolio.holdings, marks);
    snapshot.valuedAt = '2026-10-28T06:15:00Z';
    snapshotCache.set(snapshotKey(portfolio), snapshot);
    portfolio.lastSnapshot = snapshot;
  }
  positionsLoaded = false;
  positionsLoadedAt = null;
  lastAlertAt = 0;
}

function resetAlertCooldown() {
  lastAlertAt = 0;
}

function httpError(message, code, statusCode) {
  const error = new Error(message);
  error.name = statusCode === 404 ? 'NotFoundError' : 'ValidationError';
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function findPortfolio(portfolioId) {
  const portfolio = portfolios.find((candidate) => candidate.id === portfolioId);
  if (!portfolio) throw httpError(`Unknown portfolio "${portfolioId}".`, 'UNKNOWN_PORTFOLIO', 404);
  return portfolio;
}

function fetchMark(assetId) {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(markStore.get(assetId) || { assetId, marketValue: null, source: 'vendor-pending' });
    }, MARK_LOOKUP_MS);
  });
}

function withDeadline(promise, startTime) {
  let timer;
  const remaining = Math.max(0, VALUATION_DEADLINE_MS - (Date.now() - startTime));
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Portfolio valuation exceeded the ${VALUATION_DEADLINE_MS}ms request deadline`);
      error.name = 'TimeoutError';
      error.code = 'VALUATION_TIMEOUT';
      error.statusCode = 504;
      reject(error);
    }, remaining);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function lookupMarks(holdings, startTime) {
  const marks = [];
  for (const item of holdings) {
    marks.push(await withDeadline(fetchMark(item.assetId), startTime));
  }
  return marks;
}

async function valuationSnapshot(portfolio, startTime) {
  const key = snapshotKey(portfolio);
  const cached = snapshotCache.get(key);
  if (cached) return cached;
  const marks = await lookupMarks(portfolio.holdings, startTime);
  const snapshot = valueHoldings(portfolio.holdings, marks);
  snapshotCache.set(key, snapshot);
  portfolio.lastSnapshot = snapshot;
  return snapshot;
}

function carbonCard(portfolio, snapshot) {
  const override = portfolio.carbonOverride;
  return {
    ...snapshot.carbon,
    computedWaci: snapshot.carbon.waci,
    waci: override ? override.value : snapshot.carbon.waci,
    override,
  };
}

function summary(portfolio) {
  const snapshot = portfolio.lastSnapshot;
  return {
    id: portfolio.id,
    name: portfolio.name,
    strategy: portfolio.strategy,
    region: portfolio.region,
    manager: portfolio.manager,
    holdingsCount: portfolio.holdings.length,
    marketValue: snapshot.totalMarketValue,
    waci: portfolio.carbonOverride ? portfolio.carbonOverride.value : snapshot.carbon.waci,
    valuedAt: snapshot.valuedAt,
    status: snapshotCache.has(snapshotKey(portfolio)) ? 'Valued' : 'Positions updated',
  };
}

function listPortfolios() {
  return {
    asOf: '2026-10-28',
    esgAsOfMonth: ESG_AS_OF_MONTH,
    positionsFeed: {
      lastLoadAt: positionsLoadedAt || '2026-10-28T06:10:00Z',
      batchId: positionsLoaded ? NIGHTLY_BATCH_ID : 'NPL-20261028-0210',
    },
    portfolios: portfolios.map(summary),
  };
}

const REMEDIATION_DIRECTIVE = [
  `*Repository to investigate and fix:* \`COG-GTM/event-driven-devin\` (branch \`${SOURCE_BRANCH}\`)`,
  '',
  'AssetCentral cannot open the Sample Corporate Portfolio after the nightly positions load: the page hangs for several seconds and then shows "Portfolio unavailable" while the API returns HTTP 500. Other portfolios still open.',
  '- Service: `app/services/verticals/62b9367b.js`',
  '- Route: `app/routes/verticals/62b9367b.js`',
  '- Page: `app/public/verticals/62b9367b.html` (served at `/pgim`)',
  '',
  'Steps:',
  '1. Find the root cause from the code and telemetry. Before changing any code, post a short root cause in the Slack alert thread: two or three plain sentences a non-engineer can follow (what failed, why, and who is affected).',
  '2. Fix the cause, not the crash site. A holding that arrives without a price must not take the whole portfolio down, and the valuation must not pay one serial round trip per holding on every open. Portfolios that already open must show the same values.',
  '3. Add a regression test under `tests/`. Run `npx jest tests/62b9367b-assetcentral.test.js --forceExit` and `npm run lint`.',
  '4. Reproduce and verify on a local server only (`PORT=3100 node app/server.js`, open `/pgim`, click "Run nightly positions load", then open the Sample Corporate Portfolio): it must open quickly and every other portfolio must still open.',
  `5. Open a pull request against \`${SOURCE_BRANCH}\` whose description ends with \`Devin-Org: engineering\`, post the PR link in the Slack alert thread, and stop for human review. Do not merge.`,
].join('\n');

async function resolveUserIdByEmail(email, orgId) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized || !orgId) return '';
  try {
    const { apiKey } = getCustomerConfig(CUSTOMER);
    const auth = apiKey ? { apiKey } : {};
    const members = await listOrgUsers(orgId, auth);
    const member = members.find((user) => (user.email || '').toLowerCase() === normalized);
    if (member) return member.user_id;
    const admins = await listEnterpriseAdmins(auth);
    const admin = admins.find((user) => (user.email || '').toLowerCase() === normalized);
    if (admin) return admin.user_id;
    logger.warn('AssetCentral reporter email not found in org', { orgId });
  } catch (error) {
    logger.warn('AssetCentral reporter lookup failed', { error: error.message, orgId });
  }
  return '';
}

function raiseAlert(error, portfolio, reference, data) {
  const now = Date.now();
  if (now - lastAlertAt < ALERT_COOLDOWN_MS) {
    logger.warn('AssetCentral portfolio alert suppressed by cooldown', {
      reference,
      cooldownMs: ALERT_COOLDOWN_MS,
      msSinceLastAlert: now - lastAlertAt,
    });
    return Promise.resolve({ triggered: false, suppressed: true });
  }
  lastAlertAt = now;

  const tags = [
    { key: 'route', value: ROUTE },
    { key: 'service', value: SERVICE },
    { key: 'portfolio_id', value: portfolio.id },
    { key: 'positions_batch', value: NIGHTLY_BATCH_ID },
  ];

  const send = (devinUserId) => createSessionAndAlert({
    issueTitle: `${error.name}: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/62b9367b.js in valueHoldings',
    errorType: error.name || 'Error',
    errorValue: error.message,
    devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'AssetCentral, portfolio valuation',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: CUSTOMER,
    slackMemberIdFallback: SLACK_MEMBER_ID_FALLBACK,
    tags,
    extra: { reference, portfolioId: portfolio.id, holdingsCount: portfolio.holdings.length },
    level: 'error',
    platform: 'node',
    firstSeen: '',
    lastSeen: new Date().toISOString(),
    count: '',
    shortId: '',
    project: 'event-driven-devin',
    release: RELEASE,
    environment: process.env.DD_ENV || 'prod',
    triggeredRule: '',
  });

  const needsLookup = !data.devinUserId && data.devinEmail && data.devinOrgId;
  const releaseCooldown = () => {
    if (lastAlertAt === now) lastAlertAt = 0;
  };
  return (needsLookup
    ? resolveUserIdByEmail(data.devinEmail, data.devinOrgId).then((userId) => send(userId || undefined))
    : send(data.devinUserId || undefined)
  ).then((result) => {
    if (!result) releaseCooldown();
    return result;
  }).catch((alertError) => {
    releaseCooldown();
    logger.error('Failed to raise alert for AssetCentral portfolio failure', {
      error: alertError.message,
      reference,
    });
  });
}

async function openPortfolio(portfolioId, data = {}) {
  const portfolio = findPortfolio(portfolioId);
  const startTime = Date.now();
  const reference = `AC-${uuidv4().slice(0, 8).toUpperCase()}`;

  logger.info('Opening AssetCentral portfolio', {
    reference,
    portfolioId: portfolio.id,
    positionsVersion: portfolio.positionsVersion,
    holdingsCount: portfolio.holdings.length,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    const snapshot = await valuationSnapshot(portfolio, startTime);
    const duration = Date.now() - startTime;
    incrementMetric('assetcentral_portfolio.success', { route: ROUTE, portfolio: portfolio.id });
    recordTiming('assetcentral_portfolio.latency', duration, { route: ROUTE });
    return {
      success: true,
      reference,
      portfolio: {
        id: portfolio.id,
        name: portfolio.name,
        strategy: portfolio.strategy,
        region: portfolio.region,
        manager: portfolio.manager,
      },
      totalMarketValue: snapshot.totalMarketValue,
      valuedAt: snapshot.valuedAt,
      holdings: snapshot.holdings.map(({ assetId, asset, propertyType, market, marketValue, weight }) => ({
        assetId, asset, propertyType, market, marketValue, weight,
      })),
      carbon: carbonCard(portfolio, snapshot),
      audit: portfolio.audit,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('assetcentral_portfolio.failure', { route: ROUTE, portfolio: portfolio.id, errorClass: error.name });
    recordTiming('assetcentral_portfolio.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('AssetCentral portfolio valuation failed', {
      reference,
      portfolioId: portfolio.id,
      error: error.message,
      errorClass: error.name,
      stack: error.stack,
      durationMs: duration,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, portfolio_id: portfolio.id, alert_path: 'instant' },
      extra: { reference, positionsVersion: portfolio.positionsVersion },
    });

    raiseAlert(error, portfolio, reference, data);

    error.reference = reference;
    throw error;
  }
}

function runPositionsLoad() {
  const startedAt = new Date().toISOString();
  if (positionsLoaded) {
    return { success: true, batchId: NIGHTLY_BATCH_ID, inserted: 0, updated: 0, message: 'No new positions since the last load.' };
  }
  const portfolio = findPortfolio(CORPORATE_PORTFOLIO_ID);
  portfolio.holdings.push({ ...NIGHTLY_POSITION });
  portfolio.positionsVersion += 1;
  portfolio.audit.unshift(auditEntry(
    startedAt,
    'positions-loader',
    'Nightly positions load',
    `Batch ${NIGHTLY_BATCH_ID}: inserted ${NIGHTLY_POSITION.asset} (${NIGHTLY_POSITION.assetId}).`,
  ));
  positionsLoaded = true;
  positionsLoadedAt = startedAt;
  logger.info('AssetCentral nightly positions load complete', {
    batchId: NIGHTLY_BATCH_ID,
    portfolioId: portfolio.id,
    inserted: 1,
    service: 'assetcentral-positions-loader',
  });
  return {
    success: true,
    batchId: NIGHTLY_BATCH_ID,
    inserted: 1,
    updated: 0,
    reconciledPortfolios: portfolios.length,
    message: `Batch ${NIGHTLY_BATCH_ID} loaded: 1 position inserted across ${portfolios.length} portfolios.`,
  };
}

function overrideCarbonIntensity(portfolioId, body = {}) {
  const portfolio = findPortfolio(portfolioId);
  const value = Number(body.value);
  const reason = String(body.reason || '').trim();
  if (!Number.isFinite(value) || value < 0 || value > 5000) {
    throw httpError('Enter a carbon intensity between 0 and 5,000 tCO2e per USD m revenue.', 'INVALID_VALUE', 400);
  }
  if (reason.length < 10) {
    throw httpError('A reason of at least 10 characters is required to override carbon intensity.', 'REASON_REQUIRED', 400);
  }
  const by = SIGNED_IN_ANALYST;
  const at = new Date().toISOString();
  const rounded = Math.round(value * 10) / 10;
  portfolio.carbonOverride = { value: rounded, reason: reason.slice(0, 500), by, at };
  portfolio.audit.unshift(auditEntry(at, by, 'Carbon intensity override', `WACI set to ${rounded.toFixed(1)}. Reason: ${reason.slice(0, 500)}`));
  return { success: true, override: portfolio.carbonOverride, audit: portfolio.audit };
}

resetDemoState();

module.exports = {
  CORPORATE_PORTFOLIO_ID,
  CUSTOMER,
  MARK_LOOKUP_MS,
  Money,
  NIGHTLY_POSITION,
  REMEDIATION_DIRECTIVE,
  ROUTE,
  SERVICE,
  VALUATION_DEADLINE_MS,
  listPortfolios,
  openPortfolio,
  overrideCarbonIntensity,
  resetAlertCooldown,
  resetDemoState,
  runPositionsLoad,
  valueHoldings,
};
