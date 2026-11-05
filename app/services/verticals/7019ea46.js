// Whiskas UK — Dry Cat Food "Buy Now" (where-to-buy) service.
//
// The product grid mirrors whiskas.co.uk/cat-food/dry-cat-food. Clicking BUY NOW on a
// product opens the retailer picker, which asks this service for live retailer offers
// (price, stock, deep link). Offers are priced from a life-stage RRP band table.
//
// Planted defect: LIFE_STAGE_PRICING only has `kitten` and `adult` bands. "Senior 7+ with
// Chicken" was added to the range with lifeStage `senior`, so pricing its offers throws
//   TypeError: Cannot read properties of undefined (reading 'rrpPerKg')
// Every alert carries a hardcoded New Relic APM incident signal alongside the Sentry issue.
const Sentry = require('@sentry/node');
const { createSessionAndAlert } = require('../devin-session');
const logger = require('../../telemetry/logger');

const CUSTOMER = '7019ea46';
const SERVICE = 'whiskas-dry-food-buy-now';
const ROUTE = 'POST /api/7019ea46/buy-now';
const CULPRIT = 'app/services/verticals/7019ea46.js \u2014 priceRetailerOffer';

const IMG_BASE = 'https://www.whiskas.co.uk/cdn-cgi/image/width=410,format=auto,q=90/sites/g/files/fnmzdf10251/files/migrate-product-files/images/';
const LOGO_BASE = 'https://www.whiskas.co.uk/cdn-cgi/image/format=auto,q=90/sites/g/files/fnmzdf10251/files/upload/images_where_to_buy/';

const CATALOG = [
  { ean: '5900951355875', slug: 'kitten-2-12-months-with-tuna', name: 'Kitten 2-12 Months with Tuna Dry Kitten Food', image: `${IMG_BASE}l6fgnuydupts3jwzpzmh.png`, lifeStage: 'kitten', age: 'Kitten', subBrand: 'Kitten', packaging: 'Bag', flavour: 'Tuna', packKg: 0.8 },
  { ean: '5998749128596', slug: '1-adult-with-salmon', name: '1+ Adult with Salmon Dry Cat Food', image: `${IMG_BASE}v8wfv2uost5bxh8a0apo.png`, lifeStage: 'adult', age: 'Adult 1+', subBrand: 'Core', packaging: 'Bag', flavour: 'Salmon', packKg: 1.9 },
  { ean: '5998749128619', slug: '1-adult-with-lamb', name: '1+ Adult with Lamb Dry Cat Food', image: `${IMG_BASE}zqiymkw2qbgee2r1q0hv.png`, lifeStage: 'adult', age: 'Adult 1+', subBrand: 'Core', packaging: 'Bag', flavour: 'Lamb', packKg: 1.9 },
  { ean: '5998749128602', slug: '1-adult-with-tuna', name: '1+ Adult with Tuna Dry Cat Food', image: `${IMG_BASE}dgarb2bhlhwzekp4urih.png`, lifeStage: 'adult', age: 'Adult 1+', subBrand: 'Core', packaging: 'Bag', flavour: 'Tuna', packKg: 1.9 },
  { ean: '5900951355868', slug: 'kitten-2-12-months-with-chicken', name: 'Kitten 2-12 Months with Chicken Dry Kitten Food', image: `${IMG_BASE}qexwtlnqq7iqj0o9jwpv.png`, lifeStage: 'kitten', age: 'Kitten', subBrand: 'Kitten', packaging: 'Box', flavour: 'Chicken', packKg: 0.3 },
  { ean: '5900951291043', slug: '1-adult-duo-surf-turf', name: '1+ Adult Duo Surf & Turf Dry Cat Food', image: `${IMG_BASE}ys1ovcbcntbf3j49nt3w.png`, lifeStage: 'adult', age: 'Adult 1+', subBrand: 'Duo', packaging: 'Bag', flavour: 'Surf & Turf', packKg: 0.8 },
  { ean: '5900951291036', slug: '1-adult-meaty-combos', name: '1+ Adult Meaty Combos Dry Cat Food', image: `${IMG_BASE}v8rzdinmcvf2xtuf73fe.png`, lifeStage: 'adult', age: 'Adult 1+', subBrand: 'Duo', packaging: 'Bag', flavour: 'Meaty Combos', packKg: 0.8 },
  { ean: '5998749128589', slug: '1-adult-with-chicken', name: '1+ Adult with Chicken Dry Cat Food', image: `${IMG_BASE}q8op6j3km9jkadqnangm.png`, lifeStage: 'adult', age: 'Adult 1+', subBrand: 'Core', packaging: 'Bag', flavour: 'Chicken', packKg: 1.9 },
  { ean: '5998749128626', slug: 'senior-7-with-chicken', name: 'Senior 7+ with Chicken Dry Cat Food', image: `${IMG_BASE}dwlshw2wer2zvdltwqdx.png`, lifeStage: 'senior', age: 'Senior 7+', subBrand: 'Core', packaging: 'Bag', flavour: 'Chicken', packKg: 0.8 },
];

const RETAILERS = [
  { id: 'tesco', name: 'Tesco', logo: `${LOGO_BASE}uk-buy-now-logo_0006_Layer%202_0.jpg`, url: 'https://www.tesco.com/groceries/en-GB/search?query=whiskas', multiplier: 1.0, stock: 'In stock' },
  { id: 'asda', name: 'ASDA', logo: `${LOGO_BASE}uk-buy-now-logo_0004_ASDA%20Logo.jpg`, url: 'https://groceries.asda.com/search/whiskas', multiplier: 0.96, stock: 'In stock' },
  { id: 'morrisons', name: 'Morrisons', logo: `${LOGO_BASE}uk-buy-now-logo_0002_Morrisons-logo-500x281.jpg`, url: 'https://groceries.morrisons.com/search?entry=whiskas', multiplier: 1.04, stock: 'In stock' },
  { id: 'sainsburys', name: "Sainsbury's", logo: `${LOGO_BASE}uk-buy-now-logo_0003_indir.jpg`, url: 'https://www.sainsburys.co.uk/gol-ui/SearchResults/whiskas', multiplier: 1.02, stock: 'Low stock' },
  { id: 'petsathome', name: 'Pets at Home', logo: `${LOGO_BASE}uk-buy-now-logo_0005_PETS.L.jpg`, url: 'https://www.petsathome.com/search?q=whiskas', multiplier: 1.08, stock: 'In stock' },
  { id: 'amazon', name: 'Amazon', logo: `${LOGO_BASE}uk-buy-now-logo_0001_AMAZON.CO_.UK-LOGO-e1667578902171-300x83.jpg`, url: 'https://www.amazon.co.uk/s?k=whiskas+dry+cat+food', multiplier: 0.93, stock: 'In stock' },
  { id: 'ocado', name: 'Ocado', logo: `${LOGO_BASE}uk-buy-now-logo_0000_ocado-logo.jpg`, url: 'https://www.ocado.com/search?entry=whiskas', multiplier: 1.05, stock: 'In stock' },
];

// Recommended retail price bands by life stage (GBP per kg) and the promo applied this period.
// The range was extended with a Senior 7+ recipe but this table was never updated.
const LIFE_STAGE_PRICING = {
  kitten: { rrpPerKg: 7.5, promo: { label: 'Kitten Club 10% off', pct: 10 } },
  adult: { rrpPerKg: 4.2, promo: null },
};

const NEW_RELIC = {
  source: 'New Relic',
  accountId: '4123097',
  appName: 'whiskas-uk-web (production)',
  policy: 'Whiskas UK — Storefront Golden Signals',
  condition: 'Error rate > 5% for 5 minutes · POST /api/7019ea46/buy-now',
  errorRate: '31.4%',
  throughput: '212 rpm',
  apdex: '0.61',
  affectedTransactions: '3,972',
  incidentId: '88412067',
};

const REMEDIATION_DIRECTIVE = [
  'The customer-facing symptom: on the Whiskas UK dry cat food range page (/whiskas), pressing BUY NOW on',
  '"Senior 7+ with Chicken Dry Cat Food" fails with HTTP 500 and the retailer picker shows "We couldn\'t load retailers".',
  'The BUY NOW picker works for every kitten and adult recipe. Senior 7+ is the only recipe with lifeStage "senior".',
  '',
  'A New Relic APM incident fired alongside the Sentry issue (policy "Whiskas UK — Storefront Golden Signals",',
  'condition "Error rate > 5% for 5 minutes"). The New Relic distributed trace pins the throw to priceRetailerOffer.',
  '',
  'Fix the root cause in app/services/verticals/7019ea46.js so Senior 7+ prices correctly (a senior RRP band is the',
  'expected fix \u2014 do not drop Senior 7+ from the range and do not special-case the EAN). Add a regression test in',
  'tests/7019ea46-buy-now.test.js that prices a senior recipe, and keep existing kitten/adult tests passing.',
].join('\n');

function buildNewRelicSignal(requestId) {
  const traceId = `${requestId.replace(/[^a-z0-9]/gi, '').toLowerCase().padEnd(16, '0').slice(0, 16)}c4e1d9a0b7f2`;
  return {
    ...NEW_RELIC,
    traceId,
    incidentUrl: `https://one.newrelic.com/alerts-ai/incidents/${NEW_RELIC.incidentId}?account=${NEW_RELIC.accountId}`,
    traceUrl: `https://one.newrelic.com/distributed-tracing/trace/${traceId}?account=${NEW_RELIC.accountId}`,
    detectedAt: new Date().toISOString(),
  };
}

function newRequestId() {
  return `WK-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

function money(n) {
  return Math.round(n * 100) / 100;
}

function priceRetailerOffer(product, retailer) {
  const band = LIFE_STAGE_PRICING[product.lifeStage];
  const rrp = band.rrpPerKg * product.packKg;
  const shelf = rrp * retailer.multiplier;
  const price = band.promo ? shelf * (1 - band.promo.pct / 100) : shelf;
  return {
    retailerId: retailer.id,
    retailer: retailer.name,
    logo: retailer.logo,
    url: `${retailer.url}${retailer.url.includes('?') ? '&' : '?'}ean=${product.ean}`,
    stock: retailer.stock,
    price: money(price),
    wasPrice: band.promo ? money(shelf) : null,
    promo: band.promo ? band.promo.label : null,
    pricePerKg: money(price / product.packKg),
  };
}

function reportFailure(error, context) {
  const newRelic = buildNewRelicSignal(context.requestId);
  Sentry.captureException(error, {
    tags: {
      route: ROUTE,
      service: SERVICE,
      customer: CUSTOMER,
      ean: context.ean,
      life_stage: context.lifeStage,
      apm_monitor: 'new-relic',
      alert_path: 'instant',
    },
    extra: { ...context, newRelic },
  });
  logger.info('Posting alert and triggering Devin', { service: SERVICE, newRelicIncident: newRelic.incidentId, ...context });
  createSessionAndAlert({
    issueTitle: `${error.name}: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: CULPRIT,
    errorType: error.name || 'Error',
    errorValue: error.message,
    devinUserId: context.devinUserId,
    devinEmail: context.devinEmail,
    devinOrgId: context.devinOrgId,
    service: SERVICE,
    verticalLabel: 'Whiskas Dry Cat Food \u2014 Buy Now',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: CUSTOMER,
    newRelic,
    level: 'error',
    platform: 'node',
    environment: 'prod',
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'ean', value: context.ean },
      { key: 'life_stage', value: context.lifeStage },
      { key: 'apm_monitor', value: 'new-relic' },
    ],
    extra: {
      requestId: context.requestId,
      ean: context.ean,
      product: context.product,
      newRelic,
    },
  }).catch((err) => {
    logger.error('Failed to create Devin session for Whiskas buy-now error', {
      error: err.message,
      requestId: context.requestId,
    });
  });
  return newRelic;
}

function validationError(message, code) {
  const err = new Error(message);
  err.name = 'ValidationError';
  err.status = 400;
  err.code = code;
  return err;
}

async function getRetailerOffers({ ean, devinUserId, devinOrgId, devinEmail } = {}) {
  const requestId = newRequestId();
  if (!ean || typeof ean !== 'string') throw validationError('A product EAN is required.', 'EAN_REQUIRED');
  const product = CATALOG.find((p) => p.ean === ean);
  if (!product) throw validationError(`Unknown product EAN ${ean}.`, 'UNKNOWN_PRODUCT');

  const context = {
    requestId, ean, product: product.name, lifeStage: product.lifeStage, devinUserId, devinOrgId, devinEmail,
  };
  logger.info('Whiskas buy-now retailer lookup', { service: SERVICE, requestId, ean, product: product.name });

  try {
    const offers = RETAILERS.map((retailer) => priceRetailerOffer(product, retailer))
      .sort((a, b) => a.price - b.price);
    return {
      success: true,
      requestId,
      product: { ean: product.ean, name: product.name, image: product.image, packKg: product.packKg },
      offers,
      cheapest: offers[0],
    };
  } catch (error) {
    error.status = 500;
    error.code = 'RETAILER_PRICING_FAILED';
    error.newRelic = reportFailure(error, context);
    throw error;
  }
}

module.exports = {
  getRetailerOffers,
  priceRetailerOffer,
  buildNewRelicSignal,
  CATALOG,
  RETAILERS,
  LIFE_STAGE_PRICING,
  CUSTOMER,
  SERVICE,
  ROUTE,
  CULPRIT,
};
