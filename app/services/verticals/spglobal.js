const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * S&P Global Market Intelligence — Capital IQ Pro
 *
 * Peer-group valuation multiples by sector. Used to benchmark a company's
 * fundamentals against its sector and derive an implied valuation.
 */
const PEER_MULTIPLES = {
  technology:  { peRatio: 28.5, evEbitda: 19.2, priceSales: 7.4 },
  financials:  { peRatio: 13.2, evEbitda: 10.5, priceSales: 3.1 },
  energy:      { peRatio: 11.8, evEbitda: 6.4,  priceSales: 1.6 },
  healthcare:  { peRatio: 22.1, evEbitda: 15.0, priceSales: 4.8 },
  industrials: { peRatio: 18.7, evEbitda: 12.3, priceSales: 2.2 },
};

/**
 * Mock Capital IQ Pro company fundamentals database.
 * Figures are in USD millions unless noted.
 */
const COMPANIES = [
  { ticker: 'AAPL', cik: '0000320193', name: 'Apple Inc.', sector: 'technology', exchange: 'NASDAQ', revenue: 391035, netIncome: 93736, ebitda: 134661, marketCap: 3120000, rating: 'AA+', estimates: { epsNextQ: 2.35, revenueNextQ: 124300 } },
  { ticker: 'JPM', cik: '0000019617', name: 'JPMorgan Chase & Co.', sector: 'financials', exchange: 'NYSE', revenue: 239425, netIncome: 49552, ebitda: 0, marketCap: 612400, rating: 'A-', estimates: { epsNextQ: 4.12, revenueNextQ: 41800 } },
  { ticker: 'XOM', cik: '0000034088', name: 'Exxon Mobil Corporation', sector: 'energy', exchange: 'NYSE', revenue: 344582, netIncome: 33680, ebitda: 73420, marketCap: 468900, rating: 'AA-', estimates: { epsNextQ: 1.92, revenueNextQ: 86200 } },
  { ticker: 'UNH', cik: '0000731766', name: 'UnitedHealth Group Inc.', sector: 'healthcare', exchange: 'NYSE', revenue: 371622, netIncome: 14405, ebitda: 32890, marketCap: 489300, rating: 'A+', estimates: { epsNextQ: 7.28, revenueNextQ: 99400 } },
  { ticker: 'CAT', cik: '0000018230', name: 'Caterpillar Inc.', sector: 'industrials', exchange: 'NYSE', revenue: 64809, netIncome: 10335, ebitda: 14920, marketCap: 178200, rating: 'A', estimates: { epsNextQ: 5.44, revenueNextQ: 16100 } },
];

/**
 * Recent screening activity shown on the terminal.
 */
const RECENT_SCREENS = [
  { date: '2026-06-02', screen: 'S&P 500 — Quality Factor', matches: 73, owner: 'Buy-Side Research' },
  { date: '2026-06-01', screen: 'Investment Grade Credit — Energy', matches: 41, owner: 'Credit Strategy' },
  { date: '2026-05-29', screen: 'High FCF Yield — Large Cap', matches: 58, owner: 'Portfolio Mgmt' },
  { date: '2026-05-27', screen: 'Dividend Aristocrats Review', matches: 66, owner: 'Income Desk' },
];

/**
 * Look up a company record by ticker or CIK.
 * Returns the structured profile + fundamentals for the company.
 */
function findCompany(query) {
  const company = COMPANIES.find(
    (c) => c.ticker === (query.ticker || '').toUpperCase() || c.cik === query.cik
  );
  if (!company) return null;
  return {
    profile: {
      ticker: company.ticker,
      name: company.name,
      sector: company.sector,
      exchange: company.exchange,
      rating: company.rating,
      marketCap: company.marketCap,
    },
    fundamentals: {
      revenue: company.revenue,
      netIncome: company.netIncome,
      ebitda: company.ebitda,
      estimates: company.estimates,
    },
  };
}

/**
 * Resolve the peer-group valuation context for the company.
 * Returns the sector and the applicable peer multiples.
 */
function resolveValuation(companyData, requestedSector) {
  const sector = requestedSector || companyData.profile.sector;
  const multiples = PEER_MULTIPLES[sector];
  if (!multiples) return null;

  return {
    sector,
    peerMultiples: [multiples.peRatio, multiples.evEbitda, multiples.priceSales],
  };
}

/**
 * Compute the implied valuation metrics from fundamentals and peer multiples.
 * Benchmarks the company against its sector peer group.
 */
function calculateMetrics(companyData, valuation) {
  const revenue = companyData.fundamentals.revenue;
  const netIncome = companyData.fundamentals.netIncome;
  const multiples = PEER_MULTIPLES[valuation.valuation.sector];

  const impliedByPe = netIncome * multiples.peRatio;
  const impliedBySales = revenue * multiples.priceSales;
  const blendedValuation = (impliedByPe + impliedBySales) / 2;

  return {
    sector: valuation.sector,
    peRatio: multiples.peRatio.toFixed(1),
    evEbitda: multiples.evEbitda.toFixed(1),
    priceSales: multiples.priceSales.toFixed(1),
    impliedByPe: Math.round(impliedByPe),
    impliedBySales: Math.round(impliedBySales),
    blendedValuation: Math.round(blendedValuation),
    upsideVsMarket: ((blendedValuation / companyData.profile.marketCap - 1) * 100).toFixed(1),
  };
}

/**
 * Process a Capital IQ Pro company financials lookup.
 */
async function processCompanyLookup(data) {
  const startTime = Date.now();
  const lookupId = uuidv4();

  logger.info('Processing company financials lookup', {
    lookupId,
    ticker: data.ticker,
    cik: data.cik,
    sector: data.sector,
    service: 'spglobal-api',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const companyData = findCompany(data);
    if (!companyData) {
      const err = new Error('Company not found. Please verify the ticker or CIK and try again.');
      err.name = 'CompanyNotFoundError';
      err.code = 'COMPANY_NOT_FOUND';
      throw err;
    }

    const valuation = resolveValuation(companyData, data.sector);
    const metrics = calculateMetrics(companyData, valuation);

    const duration = Date.now() - startTime;

    incrementMetric('screen.lookup.success', {
      route: '/api/spglobal/financials',
      sector: companyData.profile.sector,
    });
    recordTiming('screen.lookup.latency', duration, {
      route: '/api/spglobal/financials',
    });

    return {
      success: true,
      lookupId,
      company: companyData.profile,
      fundamentals: companyData.fundamentals,
      metrics,
      recentScreens: RECENT_SCREENS,
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('screen.lookup.failure', {
      route: '/api/spglobal/financials',
      errorClass: error.name,
      sector: data.sector,
    });
    recordTiming('screen.lookup.latency', duration, {
      route: '/api/spglobal/financials',
      error: 'true',
    });

    logger.error('Company financials lookup failed', {
      lookupId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      ticker: data.ticker,
      cik: data.cik,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/spglobal/financials',
        service: 'spglobal-api',
        sector: data.sector,
      },
      extra: {
        lookupId,
        ticker: data.ticker,
        cik: data.cik,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/spglobal.js \u2014 calculateMetrics',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: 'spglobal',
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'spglobal-api',
      verticalLabel: 'Capital IQ Pro Financials Lookup',
      tags: [
        { key: 'route', value: '/api/spglobal/financials' },
        { key: 'service', value: 'spglobal-api' },
        { key: 'sector', value: data.sector },
      ],
      extra: { lookupId, ticker: data.ticker, cik: data.cik },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'spglobal-api@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from company financials lookup error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processCompanyLookup, COMPANIES, RECENT_SCREENS };
