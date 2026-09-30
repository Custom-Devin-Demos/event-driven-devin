const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const PORTFOLIO = require('./0fb68d91-portfolio.json');

const ROUTE = '/api/0fb68d91/portfolio/search';
const SERVICE = 'customer-0fb68d91-portfolio-search';
const PERMIRA_ORIGIN = 'https://www.permira.com';
const PAGE_SIZE = 20;
const SLACK_MEMBER_ID_FALLBACK = process.env.PERMIRA_SLACK_MEMBER_ID || '';

const FILTER_OPTIONS = {
  countryRegion: [
    'apac', 'brazil', 'canada', 'dach', 'france', 'germany', 'italy', 'ireland', 'israel',
    'luxembourg', 'mena', 'netherlands', 'nordics', 'norway', 'poland', 'portugal',
    'south africa', 'south korea', 'spain', 'sweden', 'switzerland', 'uk', 'usa', 'india',
  ],
  strategy: ['flagship', 'ascent', 'pgo1', 'energy transition'],
  sectors: ['technology', 'consumer', 'healthcare', 'services'],
  status: ['current', 'realised'],
};

const COMPANY_FIELD = {
  countryRegion: 'regions',
  strategy: 'strategies',
  sectors: 'sectors',
  status: 'status',
};

const SORTS = ['latest', 'a_z', 'z_a'];

const STRATEGY_PROFILES = {
  flagship: {
    label: 'Flagship',
    assetClass: 'Private Equity',
    path: '/investing/flagship/',
    summary: 'Control investing in the upper mid-market, primarily in Europe and North America, backing global, market-leading companies across Technology, Consumer, Services and Healthcare.',
  },
  ascent: {
    label: 'Ascent',
    assetClass: 'Growth Equity',
    path: '/investing/ascent/',
    summary: 'The same thematic, sector-led approach as Flagship applied to mid-market growth companies across Europe and North America, with control, co-control and high-governance structures.',
  },
  pgo1: {
    label: 'PGO1',
    assetClass: 'Growth Equity',
    path: '/portfolio/our-portfolio/',
    summary: 'Growth investments made through the first Permira Growth Opportunities fund.',
  },
  energy_transition: {
    label: 'Energy Transition',
    assetClass: 'Private Equity',
    path: '/investing/energy-transition/',
    summary: 'Backing and scaling energy transition leaders across low carbon energy, grid modernisation, resource efficiency and the circular economy.',
  },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Permira Our Portfolio search:',
  '- Service: `app/services/verticals/0fb68d91.js`',
  '- Portfolio data: `app/services/verticals/0fb68d91-portfolio.json`',
  '- Route: `app/routes/verticals/0fb68d91.js`',
  '- Page: `app/public/verticals/0fb68d91.html` (served at `/permira`)',
  '',
  'Every strategy offered in the Strategy filter must return a result, including strategies with no portfolio companies.',
  'Preserve the existing results for Flagship, Ascent and PGO1 and for every other filter and sort.',
  'Run `npx jest tests/0fb68d91-portfolio-search.test.js --runInBand` and `npm run lint`.',
  'Verify every Strategy option at `/permira` renders a strategy spotlight and a company count.',
  'Open a pull request against `main` with the fix.',
].join('\n');

function validationError(message, code) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = 400;
  return error;
}

function normalizeQuery(data) {
  const rawFilters = data.filters === undefined || data.filters === null ? {} : data.filters;
  if (typeof rawFilters !== 'object' || Array.isArray(rawFilters)) {
    throw validationError('Filters must be an object of filter lists.', 'INVALID_FILTERS');
  }

  const filters = {};
  for (const [key, values] of Object.entries(rawFilters)) {
    if (!FILTER_OPTIONS[key]) {
      throw validationError(`Unknown filter "${key}".`, 'INVALID_FILTERS');
    }
    if (!Array.isArray(values)) {
      throw validationError(`Filter "${key}" must be a list.`, 'INVALID_FILTERS');
    }
    const selected = [...new Set(values.map((value) => String(value).trim().toLowerCase()))];
    const unknown = selected.filter((value) => !FILTER_OPTIONS[key].includes(value));
    if (unknown.length) {
      throw validationError(`Unknown ${key} option "${unknown[0]}".`, 'INVALID_FILTERS');
    }
    if (selected.length) filters[key] = selected;
  }

  const sort = data.sort === undefined || data.sort === '' ? 'latest' : data.sort;
  if (!SORTS.includes(sort)) {
    throw validationError(`Unknown sort "${sort}".`, 'INVALID_SORT');
  }

  const page = data.page === undefined ? 0 : Number(data.page);
  if (!Number.isInteger(page) || page < 0) {
    throw validationError('Page must be a non-negative integer.', 'INVALID_PAGE');
  }

  const keyword = typeof data.keyword === 'string' ? data.keyword.trim().slice(0, 80) : '';

  return { filters, sort, page, keyword };
}

function companyMatches(company, filters, keyword) {
  if (keyword && !company.name.toLowerCase().includes(keyword.toLowerCase())) return false;
  return Object.entries(filters).every(([key, selected]) => {
    const value = company[COMPANY_FIELD[key]];
    const values = Array.isArray(value) ? value : [value];
    return selected.some((option) => values.includes(option));
  });
}

function sortCompanies(companies, sort) {
  if (sort === 'latest') return companies;
  const sorted = [...companies].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  return sort === 'z_a' ? sorted.reverse() : sorted;
}

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function toCard(company) {
  const sectors = company.sectors.map(titleCase);
  return {
    name: company.name,
    logo: company.logo,
    url: `${PERMIRA_ORIGIN}${company.path}`,
    sectors,
    description: sectors.join(', '),
    status: titleCase(company.status),
  };
}

function buildStrategySpotlight(strategies, companies) {
  return (strategies || []).map((strategy) => {
    const profile = STRATEGY_PROFILES[strategy];
    return {
      strategy,
      label: profile.label,
      assetClass: profile.assetClass,
      summary: profile.summary,
      url: `${PERMIRA_ORIGIN}${profile.path}`,
      companyCount: companies.filter((company) => company.strategies.includes(strategy)).length,
    };
  });
}

async function searchPortfolio(data) {
  const startTime = Date.now();
  const searchId = `PRM-${uuidv4().slice(0, 8).toUpperCase()}`;
  const query = normalizeQuery(data);
  const strategyTag = (query.filters.strategy || ['all']).join('|');

  logger.info('Searching Permira portfolio', {
    searchId,
    filters: query.filters,
    keyword: query.keyword,
    sort: query.sort,
    page: query.page,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 90));

    const matches = sortCompanies(
      PORTFOLIO.filter((company) => companyMatches(company, query.filters, query.keyword)),
      query.sort,
    );
    const strategySpotlight = buildStrategySpotlight(query.filters.strategy, matches);
    const start = query.page * PAGE_SIZE;
    const data = matches.slice(start, start + PAGE_SIZE).map(toCard);
    const duration = Date.now() - startTime;

    incrementMetric('portfolio_search.success', { route: ROUTE, strategy: strategyTag });
    recordTiming('portfolio_search.latency', duration, { route: ROUTE });

    return {
      success: true,
      searchId,
      totalItems: matches.length,
      page: query.page,
      pageSize: PAGE_SIZE,
      hasMore: start + data.length < matches.length,
      sort: query.sort,
      filters: query.filters,
      strategySpotlight,
      data,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('portfolio_search.failure', {
      route: ROUTE,
      strategy: strategyTag,
      errorClass: error.name,
    });
    recordTiming('portfolio_search.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Permira portfolio search failed', {
      searchId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      filters: query.filters,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, strategy: strategyTag },
      extra: { searchId, filters: query.filters, keyword: query.keyword, sort: query.sort },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/0fb68d91.js — buildStrategySpotlight',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Permira Our Portfolio',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '0fb68d91',
      slackMemberIdFallback: SLACK_MEMBER_ID_FALLBACK,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'strategy', value: strategyTag },
      ],
      extra: { searchId, filters: query.filters, keyword: query.keyword, sort: query.sort },
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
      logger.error('Failed to create Devin session for Permira portfolio search error', {
        error: alertError.message,
        searchId,
      });
    });

    throw error;
  }
}

module.exports = {
  searchPortfolio,
  normalizeQuery,
  buildStrategySpotlight,
  FILTER_OPTIONS,
  STRATEGY_PROFILES,
  PAGE_SIZE,
  REMEDIATION_DIRECTIVE,
};
