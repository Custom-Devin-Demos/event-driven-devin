const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLUG = 'statestreet-mch';
const SERVICE = 'customer-statestreet-mch-nav-oversight';
const ROUTE = '/api/statestreet-mch/nav/strike';
const SLACK_MEMBER_ID = process.env.STATESTREET_MCH_SLACK_MEMBER_ID || 'U0BQZBHCNMA';

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the State Street MCH (Multi-Currency Horizon) NAV Oversight strike:',
  '- Service: `app/services/verticals/statestreet-mch.js`',
  '- Route: `app/routes/verticals/statestreet-mch.js`',
  '- Page: `app/public/verticals/statestreet-mch.html` (served at `/statestreet-mch`)',
  '',
  'Start from the fund whose NAV strike failed and work back through its positions to the',
  'FX snapshot the strike values them against — the crash site is downstream of the',
  'missing reference data, not the cause of it. A position that cannot be valued must',
  'surface as a pricing exception on the fund, never abort the strike with an unhandled error.',
  '',
  'Add a regression test under `tests/` and open a pull request against `main` with the fix.',
].join('\n');

/**
 * WM/Reuters 16:00 London closing spot, quoted as units of currency per 1 USD.
 * Loaded by the MCH FX async from the WMR subscription at 16:15 London.
 */
const FX_SNAPSHOT = {
  source: 'WMR_1600_LDN',
  label: 'WM/Reuters 16:00 London close',
  baseCcy: 'USD',
  rates: {
    USD: { mid: 1, bid: 1, ask: 1 },
    EUR: { mid: 0.9183, bid: 0.9182, ask: 0.9184 },
    GBP: { mid: 0.7641, bid: 0.764, ask: 0.7642 },
    JPY: { mid: 147.62, bid: 147.6, ask: 147.64 },
    HKD: { mid: 7.8012, bid: 7.801, ask: 7.8014 },
    KRW: { mid: 1387.4, bid: 1387.1, ask: 1387.7 },
    CNY: { mid: 7.1248, bid: 7.1245, ask: 7.1251 },
    TWD: { mid: 32.18, bid: 32.17, ask: 32.19 },
    INR: { mid: 83.94, bid: 83.93, ask: 83.95 },
  },
};

/**
 * Funds in today's MCH NAV cycle. Positions are carried as currency buckets
 * (aggregated local market value per currency) as delivered by the MCH
 * valuation async; accruals and liabilities are already in base currency.
 *
 * SSGA-EM-0219 onboarded its Stock Connect China A-share sleeve in the
 * September wave; those lines settle offshore in CNH.
 */
const FUNDS = {
  'SSGA-EM-0219': {
    fundId: 'SSGA-EM-0219',
    name: 'SSGA Emerging Markets Equity Index Fund',
    baseCcy: 'USD',
    region: 'MCHPROD1',
    fxPolicy: 'WMR_1600_LDN',
    sharesOutstanding: 48215330.112,
    priorNavPerShare: 25.779,
    toleranceBps: 150,
    accruedIncomeBase: 1842210.55,
    liabilitiesBase: 612904.18,
    initialStatus: 'PRICED',
    positions: [
      { ccy: 'USD', lines: 41, localMv: 118402331.2 },
      { ccy: 'HKD', lines: 112, localMv: 2481204410.0 },
      { ccy: 'KRW', lines: 96, localMv: 312845100000 },
      { ccy: 'TWD', lines: 88, localMv: 6820455300 },
      { ccy: 'INR', lines: 131, localMv: 15612480000 },
      { ccy: 'CNY', lines: 23, localMv: 402115800 },
      { ccy: 'CNH', lines: 64, localMv: 913420600 },
    ],
  },
  'SSGA-EQ-0042': {
    fundId: 'SSGA-EQ-0042',
    name: 'SSGA Global Equity ex-US Fund',
    baseCcy: 'USD',
    region: 'MCHPROD1',
    fxPolicy: 'WMR_1600_LDN',
    sharesOutstanding: 92140877.5,
    priorNavPerShare: 35.4102,
    toleranceBps: 150,
    accruedIncomeBase: 4128800.12,
    liabilitiesBase: 1904211.6,
    initialStatus: 'PRICED',
    positions: [
      { ccy: 'USD', lines: 58, localMv: 214880125.4 },
      { ccy: 'EUR', lines: 214, localMv: 1184220930.5 },
      { ccy: 'GBP', lines: 97, localMv: 512904377.25 },
      { ccy: 'JPY', lines: 186, localMv: 159204887000 },
    ],
  },
  'SSGA-FI-0118': {
    fundId: 'SSGA-FI-0118',
    name: 'SSGA Global Aggregate Bond Fund',
    baseCcy: 'USD',
    region: 'MCHPROD1',
    fxPolicy: 'WMR_1600_LDN',
    sharesOutstanding: 155320410.0,
    priorNavPerShare: 10.1318,
    toleranceBps: 50,
    accruedIncomeBase: 12402119.8,
    liabilitiesBase: 2210344.05,
    initialStatus: 'RELEASED',
    positions: [
      { ccy: 'USD', lines: 412, localMv: 812450330.1 },
      { ccy: 'EUR', lines: 233, localMv: 401887215.9 },
      { ccy: 'GBP', lines: 81, localMv: 128440190.0 },
      { ccy: 'JPY', lines: 44, localMv: 21480220000 },
    ],
  },
  'SSGA-GL-0007': {
    fundId: 'SSGA-GL-0007',
    name: 'SSGA Global Allocation Fund',
    baseCcy: 'USD',
    region: 'MCHPROD1',
    fxPolicy: 'WMR_1600_LDN',
    sharesOutstanding: 38402115.0,
    priorNavPerShare: 16.6511,
    toleranceBps: 100,
    accruedIncomeBase: 2201845.4,
    liabilitiesBase: 804512.9,
    initialStatus: 'PRICED',
    positions: [
      { ccy: 'USD', lines: 127, localMv: 402118440.0 },
      { ccy: 'EUR', lines: 66, localMv: 141205880.0 },
      { ccy: 'JPY', lines: 38, localMv: 6402118000 },
      { ccy: 'HKD', lines: 21, localMv: 312004500.0 },
    ],
  },
  'SSGA-US-0311': {
    fundId: 'SSGA-US-0311',
    name: 'SSGA US Large Cap Index Fund',
    baseCcy: 'USD',
    region: 'MCHPROD1',
    fxPolicy: 'WMR_1600_LDN',
    sharesOutstanding: 210448312.0,
    priorNavPerShare: 42.0388,
    toleranceBps: 150,
    accruedIncomeBase: 6340218.0,
    liabilitiesBase: 2402119.75,
    initialStatus: 'RELEASED',
    positions: [
      { ccy: 'USD', lines: 503, localMv: 8871204330.0 },
    ],
  },
};

const DEFAULT_FUND = 'SSGA-EM-0219';

const ON_CALL = [
  { name: 'Humza Rabbani', role: 'Primary · L2 NAV Operations', slackMemberId: SLACK_MEMBER_ID },
];

const strikes = {};
const statuses = {};

class ValidationError extends Error {
  constructor(message, code, statusCode = 400) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = statusCode;
    this.code = code || 'INVALID_NAV_REQUEST';
  }
}

function round(value, places) {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

function valuationDate(now = new Date()) {
  const d = new Date(now.getTime());
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Translate one currency bucket into base currency at the snapshot mid.
 */
function valuePosition(position, snapshot) {
  const rate = snapshot.rates[position.ccy];
  const baseMv = position.localMv / rate.mid;
  return {
    ccy: position.ccy,
    lines: position.lines,
    localMv: round(position.localMv, 2),
    fxRate: rate.mid,
    baseMv: round(baseMv, 2),
  };
}

/**
 * Compute the NAV for a fund against the snapshot and run the day-on-day
 * tolerance check.
 */
function computeNav(fund, snapshot = FX_SNAPSHOT) {
  const valued = fund.positions.map((position) => valuePosition(position, snapshot));
  const investmentsBase = valued.reduce((sum, p) => sum + p.baseMv, 0);
  const netAssets = investmentsBase + fund.accruedIncomeBase - fund.liabilitiesBase;
  const navPerShare = round(netAssets / fund.sharesOutstanding, 4);
  const dayMoveBps = round(((navPerShare - fund.priorNavPerShare) / fund.priorNavPerShare) * 10000, 1);

  return {
    fundId: fund.fundId,
    baseCcy: fund.baseCcy,
    fxSource: snapshot.source,
    currencies: valued,
    positionsValued: valued.reduce((sum, p) => sum + p.lines, 0),
    investmentsBase: round(investmentsBase, 2),
    accruedIncomeBase: fund.accruedIncomeBase,
    liabilitiesBase: fund.liabilitiesBase,
    netAssetsBase: round(netAssets, 2),
    sharesOutstanding: fund.sharesOutstanding,
    navPerShare,
    priorNavPerShare: fund.priorNavPerShare,
    dayMoveBps,
    toleranceBps: fund.toleranceBps,
    withinTolerance: Math.abs(dayMoveBps) <= fund.toleranceBps,
  };
}

function resolveFund(fundId) {
  const fund = FUNDS[fundId];
  if (!fund) {
    throw new ValidationError(`Fund ${fundId} is not in today's NAV cycle`, 'FUND_NOT_IN_CYCLE', 404);
  }
  return fund;
}

function statusOf(fundId) {
  return statuses[fundId] || FUNDS[fundId].initialStatus;
}

function seedReleasedStrikes() {
  for (const fund of Object.values(FUNDS)) {
    if (fund.initialStatus === 'RELEASED' && !strikes[fund.fundId]) {
      const date = valuationDate();
      strikes[fund.fundId] = {
        ...computeNav(fund),
        strikeId: `NAV-${fund.fundId.slice(5)}-SOD`,
        valuationDate: date,
        struckAt: `${date}T20:42:00.000Z`,
        struckBy: 'mch-nav-batch',
      };
    }
  }
}

/** Fund list + reference data the NAV Oversight screen renders. */
function getCycle() {
  seedReleasedStrikes();
  return {
    valuationDate: valuationDate(),
    region: 'MCHPROD1 · LPAR A',
    releaseCutoff: '18:00 America/New_York',
    defaultFund: DEFAULT_FUND,
    fxSnapshot: {
      source: FX_SNAPSHOT.source,
      label: FX_SNAPSHOT.label,
      baseCcy: FX_SNAPSHOT.baseCcy,
      rates: Object.entries(FX_SNAPSHOT.rates)
        .filter(([ccy]) => ccy !== 'USD')
        .map(([ccy, r]) => ({ ccy, mid: r.mid, bid: r.bid, ask: r.ask })),
    },
    onCall: ON_CALL.map(({ name, role }) => ({ name, role })),
    funds: Object.values(FUNDS).map((fund) => ({
      fundId: fund.fundId,
      name: fund.name,
      baseCcy: fund.baseCcy,
      fxPolicy: fund.fxPolicy,
      priorNavPerShare: fund.priorNavPerShare,
      toleranceBps: fund.toleranceBps,
      sharesOutstanding: fund.sharesOutstanding,
      accruedIncomeBase: fund.accruedIncomeBase,
      liabilitiesBase: fund.liabilitiesBase,
      positions: fund.positions.map(({ ccy, lines, localMv }) => ({ ccy, lines, localMv })),
      status: statusOf(fund.fundId),
      strike: strikes[fund.fundId] || null,
    })),
  };
}

/**
 * Strike the NAV for a fund: value every position in base currency, roll up
 * net assets, compute NAV per share and run the tolerance check.
 */
async function strikeNav(data) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const fundId = data.fundId || DEFAULT_FUND;

  logger.info('Striking fund NAV', {
    requestId, fundId, service: SERVICE, route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 600 + Math.random() * 400));

    const fund = resolveFund(fundId);
    if (statusOf(fundId) === 'RELEASED') {
      throw new ValidationError(`NAV for ${fundId} is already released to the transfer agent`, 'NAV_ALREADY_RELEASED', 409);
    }

    const nav = computeNav(fund);
    const strike = {
      ...nav,
      strikeId: `NAV-${fundId.slice(5)}-${requestId.slice(0, 6).toUpperCase()}`,
      valuationDate: valuationDate(),
      struckAt: new Date().toISOString(),
      struckBy: data.user || 'hrabbani',
    };
    strikes[fundId] = strike;
    statuses[fundId] = nav.withinTolerance ? 'STRUCK' : 'TOLERANCE_BREACH';

    const duration = Date.now() - startTime;
    incrementMetric('nav_strike.success', { route: ROUTE, fundId });
    recordTiming('nav_strike.latency', duration, { route: ROUTE });
    logger.info('Fund NAV struck', {
      requestId,
      fundId,
      strikeId: strike.strikeId,
      navPerShare: strike.navPerShare,
      dayMoveBps: strike.dayMoveBps,
      durationMs: duration,
      service: SERVICE,
    });

    return {
      success: true, requestId, status: statuses[fundId], strike,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    if (error instanceof ValidationError) {
      incrementMetric('nav_strike.rejected', { route: ROUTE, code: error.code });
      logger.warn('Fund NAV strike rejected', {
        requestId, fundId, code: error.code, error: error.message, service: SERVICE,
      });
      error.requestId = requestId;
      throw error;
    }

    incrementMetric('nav_strike.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('nav_strike.latency', duration, { route: ROUTE, error: 'true' });
    logger.error('Fund NAV strike failed', {
      requestId,
      fundId,
      fxSource: FX_SNAPSHOT.source,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE, service: SERVICE, fundId, fxSource: FX_SNAPSHOT.source, alert_path: 'instant',
      },
      extra: { requestId },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/statestreet-mch.js \u2014 valuePosition',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'State Street MCH \u2014 NAV Oversight Strike',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 'statestreet-mch',
      slackMemberId: SLACK_MEMBER_ID,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'fundId', value: fundId },
        { key: 'fxSource', value: FX_SNAPSHOT.source },
      ],
      extra: { requestId },
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
      logger.error('Failed to create Devin session for NAV strike error', {
        requestId,
        error: alertError.message,
      });
    });

    error.requestId = requestId;
    throw error;
  }
}

/** Release a struck NAV to the transfer agent. */
function releaseNav(data) {
  const fundId = data.fundId || DEFAULT_FUND;
  resolveFund(fundId);
  const status = statusOf(fundId);
  if (status !== 'STRUCK') {
    throw new ValidationError(
      status === 'RELEASED'
        ? `NAV for ${fundId} is already released`
        : `NAV for ${fundId} must be struck within tolerance before release`,
      'NAV_NOT_RELEASABLE',
      409,
    );
  }
  statuses[fundId] = 'RELEASED';
  logger.info('Fund NAV released to transfer agent', { fundId, strikeId: strikes[fundId].strikeId, service: SERVICE });
  return { success: true, fundId, status: 'RELEASED', strike: strikes[fundId] };
}

/** Start-of-day reset: clear today's strikes and statuses. */
function resetCycle() {
  for (const key of Object.keys(strikes)) delete strikes[key];
  for (const key of Object.keys(statuses)) delete statuses[key];
}

module.exports = {
  SLUG,
  strikeNav,
  releaseNav,
  resetCycle,
  getCycle,
  computeNav,
  FUNDS,
  FX_SNAPSHOT,
  DEFAULT_FUND,
  REMEDIATION_DIRECTIVE,
};
