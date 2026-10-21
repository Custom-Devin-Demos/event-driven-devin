const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const ROUTE = '/api/oncall/portfoliofilter/companies';
const SERVICE = 'hf-portfolio-api';

const SECTORS = {
  technology: 'Technology',
  healthcare: 'Healthcare',
  'consumer-services-retail': 'Consumer Services & Retail',
  'financial-services': 'Financial Services',
  'information-content-business-services': 'Information, Content & Business Services',
};

const STATUSES = {
  current: 'Current',
  past: 'Past',
};

const GEOGRAPHIES = {
  'north-america': 'North America',
  europe: 'Europe',
};

/**
 * Portfolio companies as published on the public Our Portfolio page. `mark`
 * is the typographic treatment the page renders in place of the logo.
 */
const COMPANIES = [
  { id: 'action', name: 'Action', sectors: ['consumer-services-retail'], status: 'current', geography: 'europe', mark: 'heavy-italic' },
  { id: 'allfunds', name: 'Allfunds', sectors: ['financial-services'], status: 'current', geography: 'europe', mark: 'bold' },
  { id: 'applied-systems', name: 'Applied Systems', sectors: ['technology'], status: 'current', geography: 'north-america', mark: 'wide' },
  { id: 'athenahealth', name: 'athenahealth', sectors: ['healthcare'], status: 'current', geography: 'north-america', mark: 'light' },
  { id: 'autoscout24', name: 'AutoScout24', sectors: ['information-content-business-services'], status: 'current', geography: 'europe', mark: 'regular' },
  { id: 'baker-tilly', name: 'Baker Tilly', sectors: ['information-content-business-services'], status: 'current', geography: 'north-america', mark: 'bold' },
  { id: 'belron', name: 'Belron', sectors: ['consumer-services-retail'], status: 'current', geography: 'europe', mark: 'wide' },
  { id: 'caliber', name: 'Caliber', sectors: ['consumer-services-retail'], status: 'current', geography: 'north-america', mark: 'wide' },
  { id: 'checkmarx', name: 'Checkmarx', sectors: ['technology'], status: 'current', geography: 'north-america', mark: 'mono' },
  { id: 'circana', name: 'Circana', sectors: ['information-content-business-services'], status: 'current', geography: 'north-america', mark: 'bold' },
  { id: 'claritev', name: 'Claritev', sectors: ['healthcare'], status: 'current', geography: 'north-america', mark: 'regular' },
  { id: 'cordis', name: 'Cordis', sectors: ['healthcare'], status: 'current', geography: 'north-america', mark: 'serif' },
  { id: 'curriculum-associates', name: 'Curriculum Associates', sectors: ['information-content-business-services'], status: 'current', geography: 'north-america', mark: 'bold' },
  { id: 'edelman-financial-engines', name: 'Edelman Financial Engines', sectors: ['financial-services'], status: 'current', geography: 'north-america', mark: 'bold' },
  { id: 'genesys', name: 'Genesys', sectors: ['technology'], status: 'current', geography: 'north-america', mark: 'wide' },
  { id: 'global-music-rights', name: 'Global Music Rights', sectors: ['information-content-business-services'], status: 'current', geography: 'north-america', mark: 'caps' },
  { id: 'hub-international', name: 'HUB International', sectors: ['financial-services'], status: 'current', geography: 'north-america', mark: 'heavy' },
  { id: 'medline', name: 'Medline', sectors: ['healthcare'], status: 'current', geography: 'north-america', mark: 'badge' },
  { id: 'mehilainen', name: 'Mehil\u00e4inen', sectors: ['healthcare'], status: 'current', geography: 'europe', mark: 'caps' },
  { id: 'nexi', name: 'Nexi', sectors: ['financial-services'], status: 'current', geography: 'europe', mark: 'light' },
  { id: 'ode', name: 'ODE', sectors: ['technology'], status: 'current', geography: 'north-america', mark: 'wide' },
  { id: 'pointclickcare', name: 'PointClickCare', sectors: ['healthcare'], status: 'current', geography: 'north-america', mark: 'bold' },
  { id: 'safe-guard', name: 'Safe-Guard Products International', sectors: ['financial-services'], status: 'current', geography: 'north-america', mark: 'heavy-italic' },
  { id: 'sprinklr', name: 'Sprinklr', sectors: ['technology'], status: 'current', geography: 'north-america', mark: 'light' },
  { id: 'teamsystem', name: 'TeamSystem', sectors: ['technology'], status: 'current', geography: 'europe', mark: 'bold' },
  { id: 'ukg', name: 'UKG', sectors: ['technology'], status: 'current', geography: 'north-america', mark: 'heavy' },
  { id: 'verisure', name: 'Verisure', sectors: ['consumer-services-retail'], status: 'current', geography: 'europe', mark: 'regular' },
  { id: 'zendesk', name: 'Zendesk', sectors: ['technology'], status: 'current', geography: 'north-america', mark: 'light' },
  { id: 'zooplus', name: 'zooplus', sectors: ['consumer-services-retail'], status: 'current', geography: 'europe', mark: 'badge' },
  { id: 'activant', name: 'Activant Solutions', sectors: ['technology'], status: 'past', geography: 'north-america', mark: 'bold' },
  { id: 'catalina', name: 'Catalina Marketing', sectors: ['information-content-business-services'], status: 'past', geography: 'north-america', mark: 'regular' },
  { id: 'doubleclick', name: 'DoubleClick', sectors: ['information-content-business-services', 'technology'], status: 'past', geography: 'north-america', mark: 'bold' },
  { id: 'emdeon', name: 'Emdeon', sectors: ['healthcare'], status: 'past', geography: 'north-america', mark: 'regular' },
  { id: 'formula-one', name: 'Formula One', sectors: ['information-content-business-services'], status: 'past', geography: 'europe', mark: 'heavy-italic' },
  { id: 'gartmore', name: 'Gartmore', sectors: ['financial-services'], status: 'past', geography: 'europe', mark: 'serif' },
  { id: 'getty-images', name: 'Getty Images', sectors: ['information-content-business-services'], status: 'past', geography: 'north-america', mark: 'light' },
  { id: 'grocery-outlet', name: 'Grocery Outlet', sectors: ['consumer-services-retail'], status: 'past', geography: 'north-america', mark: 'heavy' },
  { id: 'grosvenor', name: 'Grosvenor Capital Management', sectors: ['financial-services'], status: 'past', geography: 'north-america', mark: 'serif' },
  { id: 'internet-brands', name: 'Internet Brands', sectors: ['information-content-business-services'], status: 'past', geography: 'north-america', mark: 'regular' },
  { id: 'kronos', name: 'Kronos', sectors: ['technology'], status: 'past', geography: 'north-america', mark: 'bold' },
  { id: 'nasdaq', name: 'Nasdaq', sectors: ['financial-services'], status: 'past', geography: 'north-america', mark: 'wide' },
  { id: 'openlink', name: 'OpenLink', sectors: ['technology'], status: 'past', geography: 'north-america', mark: 'regular' },
  { id: 'ppd', name: 'PPD', sectors: ['healthcare'], status: 'past', geography: 'north-america', mark: 'heavy' },
  { id: 'renaissance-learning', name: 'Renaissance Learning', sectors: ['information-content-business-services'], status: 'past', geography: 'north-america', mark: 'light' },
  { id: 'scout24', name: 'Scout24', sectors: ['information-content-business-services'], status: 'past', geography: 'europe', mark: 'regular' },
  { id: 'sedgwick', name: 'Sedgwick', sectors: ['financial-services'], status: 'past', geography: 'north-america', mark: 'bold' },
  { id: 'sheridan', name: 'Sheridan Healthcare', sectors: ['healthcare'], status: 'past', geography: 'north-america', mark: 'regular' },
  { id: 'snap-one', name: 'Snap One', sectors: ['technology'], status: 'past', geography: 'north-america', mark: 'heavy' },
  { id: 'vertafore', name: 'Vertafore', sectors: ['technology'], status: 'past', geography: 'north-america', mark: 'bold' },
  { id: 'web-reservations', name: 'Web Reservations International', sectors: ['consumer-services-retail'], status: 'past', geography: 'europe', mark: 'light' },
  { id: 'wood-mackenzie', name: 'Wood Mackenzie', sectors: ['information-content-business-services'], status: 'past', geography: 'europe', mark: 'serif' },
];

const GRID_DEADLINE_MS = 8000;
const PROFILE_LOOKUP_MS = 175;

/**
 * Company profiles (mark treatment, display name overrides) live in the
 * content store, one document per company. The grid resolves each company's
 * profile on request so edits made in the CMS show up without a redeploy.
 */
function fetchCompanyProfile(company) {
  return new Promise((resolve) => {
    setTimeout(() => resolve({ id: company.id, displayName: company.name, mark: company.mark }), PROFILE_LOOKUP_MS);
  });
}

function withDeadline(promise, ms, startTime) {
  let timer;
  const remaining = Math.max(0, ms - (Date.now() - startTime));
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Portfolio grid exceeded the ${ms}ms request deadline`);
      err.code = 'PORTFOLIO_TIMEOUT';
      reject(err);
    }, remaining);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function resolveProfiles(companies, startTime) {
  const profiles = [];
  for (const company of companies) {
    profiles.push(await withDeadline(fetchCompanyProfile(company), GRID_DEADLINE_MS, startTime));
  }
  return profiles;
}

function toCard(company, profile) {
  return {
    id: company.id,
    name: profile.displayName,
    mark: profile.mark,
    sectors: company.sectors.map((key) => SECTORS[key]),
    status: STATUSES[company.status],
    geography: GEOGRAPHIES[company.geography],
  };
}

function facet(table, value, label) {
  const key = String(value || '').trim().toLowerCase();
  if (!key || key === 'all') return null;
  if (!Object.hasOwn(table, key)) {
    const error = new Error(`Unknown ${label} filter: ${key}`);
    error.code = 'INVALID_FILTER';
    throw error;
  }
  return key;
}

/**
 * Filter the public portfolio by sector, investment status and geography,
 * resolve each company's content-store profile and group the matches into
 * the Current / Past sections the page renders.
 */
async function filterPortfolio(request, options = {}) {
  const startTime = Date.now();
  const queryId = uuidv4();
  let sector = null;
  let status = null;
  let geography = null;

  try {
    sector = facet(SECTORS, request.sector, 'sector');
    status = facet(STATUSES, request.status, 'status');
    geography = facet(GEOGRAPHIES, request.geography, 'geography');

    logger.info('Portfolio filter request', {
      queryId, sector, status, geography, service: SERVICE, route: ROUTE,
    });

    let candidates = COMPANIES;
    if (sector) candidates = candidates.filter((company) => company.sectors.includes(sector));
    if (status) candidates = candidates.filter((company) => company.status === status);
    if (geography) candidates = candidates.filter((company) => company.geography === geography);

    const profiles = await resolveProfiles(candidates, startTime);
    const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
    const sections = (status ? [status] : Object.keys(STATUSES))
      .map((key) => ({
        status: key,
        label: STATUSES[key],
        companies: candidates.filter((company) => company.status === key).map((company) => toCard(company, profileById.get(company.id))),
      }))
      .filter((section) => section.companies.length > 0);
    const duration = Date.now() - startTime;

    incrementMetric('portfoliofilter.query.success', { route: ROUTE, facets: [sector && 'sector', status && 'status', geography && 'geography'].filter(Boolean).join('+') || 'none' });
    recordTiming('portfoliofilter.query.latency', duration, { route: ROUTE });

    return {
      success: true,
      queryId,
      filters: {
        sector: sector ? SECTORS[sector] : null,
        status: status ? STATUSES[status] : null,
        geography: geography ? GEOGRAPHIES[geography] : null,
      },
      total: candidates.length,
      sections,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('portfoliofilter.query.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('portfoliofilter.query.latency', duration, { route: ROUTE, error: 'true' });
    logger.error('Portfolio filter failed', {
      queryId, error: error.message, errorClass: error.name, code: error.code, durationMs: duration, sector, status, geography,
    });
    if (error.code !== 'INVALID_FILTER') {
      Sentry.captureException(error, {
        tags: { route: ROUTE, service: SERVICE, ...(options.synthetic ? { synthetic_probe: 'true' } : {}) },
        extra: { queryId, sector, status, geography },
      });
    }
    throw error;
  }
}

module.exports = { filterPortfolio, COMPANIES, SECTORS, STATUSES, GEOGRAPHIES, GRID_DEADLINE_MS };
