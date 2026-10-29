const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const ROUTE = '/api/oncall/bxportfolio/companies';
const SERVICE = 'bx-portfolio-api';

const BUSINESSES = {
  'private-equity': 'Private Equity',
  'real-estate': 'Real Estate',
  'credit-insurance': 'Credit & Insurance',
  infrastructure: 'Infrastructure',
  'tactical-opportunities': 'Tactical Opportunities',
  'life-sciences': 'Life Sciences',
  growth: 'Growth',
};

const SECTORS = {
  technology: 'Technology',
  healthcare: 'Healthcare',
  consumer: 'Consumer',
  industrials: 'Industrials',
  'real-estate': 'Real Estate',
  'financial-services': 'Financial Services',
  'energy-infrastructure': 'Energy & Infrastructure',
  'media-entertainment': 'Media & Entertainment',
};

const REGIONS = {
  americas: 'Americas',
  europe: 'Europe',
  'asia-pacific': 'Asia Pacific',
};

/**
 * Portfolio companies as published on the public Our Portfolio page. The
 * index snapshot carries only what the unfiltered grid renders (name, blurb,
 * mark); business unit, sector and region live in each company's content
 * store profile document.
 */
const COMPANIES = [
  { id: 'jersey-mikes', name: "Jersey Mike's", business: 'private-equity', sector: 'consumer', region: 'americas', mark: 'heavy-italic', blurb: 'Leading franchisor of fast-casual submarine sandwich stores.' },
  { id: 'copeland', name: 'Copeland', business: 'private-equity', sector: 'industrials', region: 'americas', mark: 'bold', blurb: 'Global leader in energy-efficient heating, cooling and cold chain technology.' },
  { id: 'adevinta', name: 'Adevinta', business: 'private-equity', sector: 'technology', region: 'europe', mark: 'light', blurb: 'Online classifieds group operating digital marketplaces across Europe.' },
  { id: 'medline', name: 'Medline', business: 'private-equity', sector: 'healthcare', region: 'americas', mark: 'badge', blurb: 'Manufacturer and distributor of essential medical products.' },
  { id: 'legence', name: 'Legence', business: 'private-equity', sector: 'energy-infrastructure', region: 'americas', mark: 'wide', blurb: 'Energy transition accelerator for mission-critical facilities.' },
  { id: 'tdi', name: 'TDI', business: 'private-equity', sector: 'technology', region: 'americas', mark: 'heavy', blurb: 'Digital media and marketing services for the financial industry.' },
  { id: 'ancestry', name: 'Ancestry', business: 'private-equity', sector: 'consumer', region: 'americas', mark: 'serif', blurb: 'Global leader in family history and consumer genomics.' },
  { id: 'emerson-climate', name: 'Emerson Climate Technologies', business: 'private-equity', sector: 'industrials', region: 'americas', mark: 'regular', blurb: 'Compression and controls technology for HVAC and refrigeration.' },
  { id: 'spanx', name: 'SPANX', business: 'private-equity', sector: 'consumer', region: 'americas', mark: 'caps', blurb: 'Shapewear and apparel brand.' },
  { id: 'supergoop', name: 'Supergoop!', business: 'private-equity', sector: 'consumer', region: 'americas', mark: 'heavy-italic', blurb: 'Prestige SPF skincare brand.' },
  { id: 'ellucian', name: 'Ellucian', business: 'private-equity', sector: 'technology', region: 'americas', mark: 'light', blurb: 'Cloud software for higher education.' },
  { id: 'sphera', name: 'Sphera', business: 'private-equity', sector: 'technology', region: 'americas', mark: 'regular', blurb: 'ESG performance and risk management software.' },
  { id: 'bumble', name: 'Bumble', business: 'private-equity', sector: 'technology', region: 'americas', mark: 'bold', blurb: 'Women-first dating and social networking platform.' },
  { id: 'cvent', name: 'Cvent', business: 'private-equity', sector: 'technology', region: 'americas', mark: 'wide', blurb: 'Meetings, events and hospitality technology.' },
  { id: 'servpro', name: 'SERVPRO', business: 'private-equity', sector: 'consumer', region: 'americas', mark: 'caps', blurb: 'Franchisor of restoration and cleaning services.' },
  { id: 'tropical-smoothie', name: 'Tropical Smoothie Cafe', business: 'private-equity', sector: 'consumer', region: 'americas', mark: 'regular', blurb: 'Fast-casual restaurant franchisor.' },
  { id: 'chamberlain', name: 'Chamberlain Group', business: 'private-equity', sector: 'industrials', region: 'americas', mark: 'bold', blurb: 'Smart access solutions for homes and businesses.' },
  { id: 'certified-collectibles', name: 'Certified Collectibles Group', business: 'private-equity', sector: 'consumer', region: 'americas', mark: 'serif', blurb: 'Expert, impartial grading of collectibles.' },
  { id: 'link-logistics', name: 'Link Logistics', business: 'real-estate', sector: 'real-estate', region: 'americas', mark: 'heavy', blurb: 'Last-mile logistics real estate platform.' },
  { id: 'qts', name: 'QTS', business: 'real-estate', sector: 'technology', region: 'americas', mark: 'wide', blurb: 'Hyperscale and hybrid data center provider.' },
  { id: 'mileway', name: 'Mileway', business: 'real-estate', sector: 'real-estate', region: 'europe', mark: 'light', blurb: 'Last-mile logistics real estate across Europe.' },
  { id: 'hotel-investment-partners', name: 'Hotel Investment Partners', business: 'real-estate', sector: 'real-estate', region: 'europe', mark: 'serif', blurb: 'Owner and operator of resort hotels in Southern Europe.' },
  { id: 'great-wolf', name: 'Great Wolf Resorts', business: 'real-estate', sector: 'consumer', region: 'americas', mark: 'bold', blurb: 'Family indoor water park resorts.' },
  { id: 'american-campus', name: 'American Campus Communities', business: 'real-estate', sector: 'real-estate', region: 'americas', mark: 'regular', blurb: 'Student housing owner and developer.' },
  { id: 'simply-self-storage', name: 'Simply Self Storage', business: 'real-estate', sector: 'real-estate', region: 'americas', mark: 'caps', blurb: 'Self-storage owner and operator.' },
  { id: 'crown-resorts', name: 'Crown Resorts', business: 'real-estate', sector: 'consumer', region: 'asia-pacific', mark: 'serif', blurb: 'Integrated resorts in Australia.' },
  { id: 'embassy-office-parks', name: 'Embassy Office Parks', business: 'real-estate', sector: 'real-estate', region: 'asia-pacific', mark: 'wide', blurb: "India's first listed REIT." },
  { id: 'logicor', name: 'Logicor', business: 'real-estate', sector: 'real-estate', region: 'europe', mark: 'heavy', blurb: 'European logistics real estate.' },
  { id: 'candle-media', name: 'Candle Media', business: 'growth', sector: 'media-entertainment', region: 'americas', mark: 'light', blurb: 'Next-generation media company.' },
  { id: 'rover', name: 'Rover', business: 'private-equity', sector: 'technology', region: 'americas', mark: 'regular', blurb: 'Marketplace for pet care.' },
  { id: 'oatly', name: 'Oatly', business: 'growth', sector: 'consumer', region: 'europe', mark: 'heavy-italic', blurb: 'Plant-based dairy alternatives.' },
  { id: 'hotwire', name: 'Hotwire Communications', business: 'infrastructure', sector: 'energy-infrastructure', region: 'americas', mark: 'bold', blurb: 'Fiber-to-the-home broadband provider.' },
  { id: 'invenergy', name: 'Invenergy Renewables', business: 'infrastructure', sector: 'energy-infrastructure', region: 'americas', mark: 'wide', blurb: 'Largest private renewable energy developer in North America.' },
  { id: 'airtrunk', name: 'AirTrunk', business: 'infrastructure', sector: 'technology', region: 'asia-pacific', mark: 'caps', blurb: 'Hyperscale data center platform across Asia Pacific.' },
  { id: 'signature-aviation', name: 'Signature Aviation', business: 'infrastructure', sector: 'industrials', region: 'europe', mark: 'serif', blurb: 'Private aviation terminal operator.' },
  { id: 'anthos', name: 'Anthos Therapeutics', business: 'life-sciences', sector: 'healthcare', region: 'americas', mark: 'light', blurb: 'Clinical-stage biopharmaceutical company.' },
  { id: 'tarsus', name: 'Tarsus Pharmaceuticals', business: 'life-sciences', sector: 'healthcare', region: 'americas', mark: 'regular', blurb: 'Eye care and infectious disease therapeutics.' },
  { id: 'carrix', name: 'Carrix', business: 'infrastructure', sector: 'industrials', region: 'americas', mark: 'heavy', blurb: 'Marine terminal operator.' },
  { id: 'interior-logic', name: 'Interior Logic Group', business: 'tactical-opportunities', sector: 'industrials', region: 'americas', mark: 'bold', blurb: 'Interior design and installation for homebuilders.' },
  { id: 'esdec', name: 'Esdec Solar Group', business: 'credit-insurance', sector: 'energy-infrastructure', region: 'europe', mark: 'wide', blurb: 'Rooftop solar mounting systems.' },
];

const FILTER_DEADLINE_MS = 6000;
const PROFILE_LOOKUP_MS = Number(process.env.BX_PROFILE_LOOKUP_MS) || 200;

const CACHED_INDEX = COMPANIES.map((company) => ({
  id: company.id,
  name: company.name,
  mark: company.mark,
  blurb: company.blurb,
}));

/**
 * Company profiles (business unit, sector, region) live in the content
 * store as one document per company. The filtered grid resolves each
 * company's profile on request so edits made in the CMS show up without
 * a redeploy.
 */
function fetchCompanyProfile(company) {
  return new Promise((resolve) => {
    setTimeout(() => resolve({
      id: company.id,
      business: company.business,
      sector: company.sector,
      region: company.region,
    }), PROFILE_LOOKUP_MS);
  });
}

function withDeadline(promise, ms, startTime) {
  let timer;
  const remaining = Math.max(0, ms - (Date.now() - startTime));
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Portfolio filter exceeded the ${ms}ms request deadline`);
      err.code = 'PORTFOLIO_FILTER_TIMEOUT';
      reject(err);
    }, remaining);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function resolveProfiles(companies, startTime) {
  const profiles = [];
  for (const company of companies) {
    profiles.push(await withDeadline(fetchCompanyProfile(company), FILTER_DEADLINE_MS, startTime));
  }
  return profiles;
}

function toCard(company, profile) {
  return {
    id: company.id,
    name: company.name,
    mark: company.mark,
    blurb: company.blurb,
    business: profile ? BUSINESSES[profile.business] : null,
    sector: profile ? SECTORS[profile.sector] : null,
    region: profile ? REGIONS[profile.region] : null,
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
 * List the public portfolio. The unfiltered grid is served from the cached
 * index snapshot; a business unit, sector or region filter has to resolve
 * every company's content-store profile to decide which companies match.
 */
async function filterPortfolio(request, options = {}) {
  const startTime = Date.now();
  const queryId = uuidv4();
  let business = null;
  let sector = null;
  let region = null;

  try {
    business = facet(BUSINESSES, request.business, 'business');
    sector = facet(SECTORS, request.sector, 'sector');
    region = facet(REGIONS, request.region, 'region');
    const filtered = Boolean(business || sector || region);

    logger.info('Portfolio filter request', {
      queryId, business, sector, region, service: SERVICE, route: ROUTE,
    });

    let companies;
    if (!filtered) {
      companies = CACHED_INDEX.map((entry) => toCard(entry, null));
    } else {
      const profiles = await resolveProfiles(COMPANIES, startTime);
      const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
      companies = COMPANIES
        .filter((company) => {
          const profile = profileById.get(company.id);
          return (!business || profile.business === business)
            && (!sector || profile.sector === sector)
            && (!region || profile.region === region);
        })
        .map((company) => toCard(company, profileById.get(company.id)));
    }
    const duration = Date.now() - startTime;

    incrementMetric('bxportfolio.query.success', { route: ROUTE, facets: [business && 'business', sector && 'sector', region && 'region'].filter(Boolean).join('+') || 'none' });
    recordTiming('bxportfolio.query.latency', duration, { route: ROUTE });

    return {
      success: true,
      queryId,
      filters: {
        business: business ? BUSINESSES[business] : null,
        sector: sector ? SECTORS[sector] : null,
        region: region ? REGIONS[region] : null,
      },
      total: companies.length,
      companies,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('bxportfolio.query.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('bxportfolio.query.latency', duration, { route: ROUTE, error: 'true' });
    logger.error('Portfolio filter failed', {
      queryId, error: error.message, errorClass: error.name, code: error.code, durationMs: duration, business, sector, region,
    });
    if (error.code !== 'INVALID_FILTER') {
      Sentry.captureException(error, {
        tags: { route: ROUTE, service: SERVICE, ...(options.synthetic ? { synthetic_probe: 'true' } : {}) },
        extra: { queryId, business, sector, region },
      });
    }
    throw error;
  }
}

module.exports = { filterPortfolio, COMPANIES, BUSINESSES, SECTORS, REGIONS, FILTER_DEADLINE_MS };
