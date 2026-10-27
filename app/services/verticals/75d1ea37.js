const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'customer-75d1ea37-plan-pricing';
const ROUTE = '/api/75d1ea37/plan-estimates';
const QUOTE_PREFIX = 'AGL-Q';

/** AER / ESC reference usage for the published estimates. */
const REFERENCE_USAGE = { electricityKwhPerYear: 3900, gasMjPerDay: 39 };
const JOIN_ONLINE_CREDIT = { electricity: 150, gas: 150 };
const SOLAR_EXPORT_KWH_PER_YEAR = 2400;

/**
 * Known supply points returned by the address finder (MSATS NMI discovery,
 * cached). The meter type drives which network tariff the site is assigned.
 */
const SUPPLY_POINTS = {
  '12 harris street, pyrmont nsw 2009': { nmi: '4102 4471 83', postcode: '2009', state: 'NSW', network: 'ausgrid', meterType: 'smart', gasNetwork: 'jemena-nsw' },
  '41 campbell parade, bondi beach nsw 2026': { nmi: '4102 0098 15', postcode: '2026', state: 'NSW', network: 'ausgrid', meterType: 'basic', gasNetwork: 'jemena-nsw' },
  '48 station street, penrith nsw 2750': { nmi: '4310 8823 06', postcode: '2750', state: 'NSW', network: 'endeavour', meterType: 'smart', gasNetwork: 'jemena-nsw' },
  '220 lygon street, carlton vic 3053': { nmi: '6102 5531 92', postcode: '3053', state: 'VIC', network: 'citipower', meterType: 'smart', gasNetwork: 'multinet' },
  '15 grey street, south brisbane qld 4101': { nmi: '3117 2290 44', postcode: '4101', state: 'QLD', network: 'energex', meterType: 'smart', gasNetwork: 'agn-qld' },
  '90 king william street, adelaide sa 5000': { nmi: '2002 1187 60', postcode: '5000', state: 'SA', network: 'sapn', meterType: 'smart', gasNetwork: 'agn-sa' },
};

const NETWORKS = {
  ausgrid: { label: 'Ausgrid', state: 'NSW', referenceScheme: 'DMO', referencePrice: 1899 },
  endeavour: { label: 'Endeavour Energy', state: 'NSW', referenceScheme: 'DMO', referencePrice: 1957 },
  citipower: { label: 'CitiPower', state: 'VIC', referenceScheme: 'VDO', referencePrice: 1611 },
  energex: { label: 'Energex', state: 'QLD', referenceScheme: 'DMO', referencePrice: 1778 },
  sapn: { label: 'SA Power Networks', state: 'SA', referenceScheme: 'DMO', referencePrice: 2263 },
};

const GAS_NETWORKS = {
  'jemena-nsw': { label: 'Jemena Gas Networks (NSW)', dailySupplyCents: 79.2, usageCentsPerMj: 3.43 },
  multinet: { label: 'Multinet Gas', dailySupplyCents: 92.4, usageCentsPerMj: 3.05 },
  'agn-qld': { label: 'Australian Gas Networks (QLD)', dailySupplyCents: 85.8, usageCentsPerMj: 4.12 },
  'agn-sa': { label: 'Australian Gas Networks (SA)', dailySupplyCents: 88.0, usageCentsPerMj: 3.89 },
};

/*
 * FY27 network tariff reassignment (effective 1 July 2026). Under Ausgrid's
 * 2026-27 pricing proposal every smart-metered residential site moved from
 * the EA025 time-of-use tariff to the EA111 residential demand time-of-use
 * tariff. Market Ops updated the assignment below with the tariff file drop;
 * the matching FY27 retail rate cards follow in the quarterly price sync.
 */
const NETWORK_TARIFF_ASSIGNMENT = {
  'ausgrid:basic': 'EA010',
  'ausgrid:smart': 'EA111',
  'endeavour:basic': 'N70',
  'endeavour:smart': 'N71',
  'citipower:smart': 'C1R',
  'energex:basic': '8400',
  'energex:smart': '6900',
  'sapn:basic': 'RSR',
  'sapn:smart': 'RTOU',
};

/** AGL Smart Saver retail rate cards (incl. GST), keyed by network tariff code. */
const RETAIL_RATE_CARDS = {
  EA010: { network: 'ausgrid', structure: 'single rate', dailySupplyCharge: 108.9, usageCentsPerKwh: 32.47 },
  EA025: { network: 'ausgrid', structure: 'time of use', dailySupplyCharge: 115.5, usageCentsPerKwh: 33.1 },
  N70: { network: 'endeavour', structure: 'single rate', dailySupplyCharge: 101.2, usageCentsPerKwh: 35.64 },
  N71: { network: 'endeavour', structure: 'time of use', dailySupplyCharge: 104.5, usageCentsPerKwh: 35.2 },
  C1R: { network: 'citipower', structure: 'single rate', dailySupplyCharge: 96.8, usageCentsPerKwh: 29.15 },
  8400: { network: 'energex', structure: 'single rate', dailySupplyCharge: 115.94, usageCentsPerKwh: 30.36 },
  6900: { network: 'energex', structure: 'time of use', dailySupplyCharge: 115.94, usageCentsPerKwh: 30.1 },
  RSR: { network: 'sapn', structure: 'single rate', dailySupplyCharge: 104.39, usageCentsPerKwh: 43.56 },
  RTOU: { network: 'sapn', structure: 'time of use', dailySupplyCharge: 104.39, usageCentsPerKwh: 41.9 },
};

const PLANS = [
  { id: 'smart-saver', name: 'AGL Smart Saver', tagline: 'For homes that want everyday low rates', usageFactor: 1, monthlyInclusion: 0, freeUsageShare: 0 },
  { id: 'netflix', name: 'AGL Netflix Plan', tagline: 'For homes that love Netflix', usageFactor: 1.004, monthlyInclusion: 0, freeUsageShare: 0, addOn: 'Netflix Standard with ads included' },
  { id: 'three-for-free', name: 'AGL Three for Free', tagline: 'For homes that can shift electricity usage to 11am\u20132pm', usageFactor: 1.24, monthlyInclusion: 0, freeUsageShare: 0.12, joinCredit: false },
];

const SOLAR_FEED_IN_CENTS = 8;

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the AGL Energy "Compare electricity and gas plans" vertical:',
  '- Service: `app/services/verticals/75d1ea37.js`',
  '- Route: `app/routes/verticals/75d1ea37.js`',
  '- Page: `app/public/verticals/75d1ea37.html` (served at `/75d1ea37`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function validationError(message, code) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = 400;
  return error;
}

function normaliseAddress(address) {
  return address.toLowerCase().replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim();
}

function validateEstimateRequest(data) {
  if (data.address.length < 8) throw validationError('Enter your street address to see estimates.', 'ADDRESS_REQUIRED');
  if (data.address.length > 200) throw validationError('Enter a shorter street address.', 'ADDRESS_TOO_LONG');
  if (!data.electricity && !data.gas) throw validationError('Choose electricity, gas or both.', 'FUEL_REQUIRED');
  if (!['monthly', 'quarterly', 'yearly'].includes(data.period)) throw validationError('Choose monthly, quarterly or yearly estimates.', 'INVALID_PERIOD');
}

function resolveSupplyPoint(address) {
  const site = SUPPLY_POINTS[normaliseAddress(address)];
  if (!site) {
    throw validationError("We couldn't find that address. Choose an address from the list.", 'ADDRESS_NOT_FOUND');
  }
  return site;
}

function resolveNetworkTariff(site) {
  const tariffCode = NETWORK_TARIFF_ASSIGNMENT[`${site.network}:${site.meterType}`];
  return { tariffCode, rateCard: RETAIL_RATE_CARDS[tariffCode] };
}

/** Annual electricity cost in dollars for a plan on the site's network tariff. */
function estimateAnnualElectricity(rateCard, plan, options) {
  const supply = (rateCard.dailySupplyCharge * 365) / 100;
  const billableKwh = REFERENCE_USAGE.electricityKwhPerYear * (1 - plan.freeUsageShare);
  const usage = (billableKwh * rateCard.usageCentsPerKwh * plan.usageFactor) / 100;
  const feedIn = options.solar ? (SOLAR_EXPORT_KWH_PER_YEAR * SOLAR_FEED_IN_CENTS) / 100 : 0;
  const credit = plan.joinCredit === false ? 0 : JOIN_ONLINE_CREDIT.electricity;
  return Math.max(0, Math.round(supply + usage - feedIn - credit));
}

function estimateAnnualGas(gasNetwork, plan) {
  const supply = (gasNetwork.dailySupplyCents * 365) / 100;
  const usage = (REFERENCE_USAGE.gasMjPerDay * 365 * gasNetwork.usageCentsPerMj) / 100;
  const credit = plan.joinCredit === false ? 0 : JOIN_ONLINE_CREDIT.gas;
  return Math.max(0, Math.round(supply + usage - credit));
}

function priceForPeriod(annual, period) {
  if (period === 'monthly') return Math.round(annual / 12);
  if (period === 'quarterly') return Math.round(annual / 4);
  return annual;
}

async function estimatePlans(data = {}) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const normalized = {
    ...data,
    address: String(data.address ?? '').trim(),
    electricity: data.electricity !== false,
    gas: data.gas !== false,
    solar: data.solar === true,
    electricVehicle: data.electricVehicle === true,
    period: String(data.period ?? 'yearly').trim().toLowerCase(),
  };

  validateEstimateRequest(normalized);
  const site = resolveSupplyPoint(normalized.address);
  const network = NETWORKS[site.network];

  logger.info('Pricing AGL residential plans for supply point', {
    requestId,
    state: site.state,
    postcode: site.postcode,
    network: site.network,
    meterType: site.meterType,
    service: SERVICE,
    route: ROUTE,
  });

  let tariffCode;
  try {
    await new Promise((resolve) => setTimeout(resolve, 90 + Math.random() * 140));

    const tariff = resolveNetworkTariff(site);
    tariffCode = tariff.tariffCode;
    const gasNetwork = GAS_NETWORKS[site.gasNetwork];

    const plans = PLANS.map((plan) => {
      const result = { id: plan.id, name: plan.name, tagline: plan.tagline, addOn: plan.addOn || null };
      if (normalized.electricity) {
        const annual = estimateAnnualElectricity(tariff.rateCard, plan, normalized);
        const vsReference = Math.round(((network.referencePrice - annual) / network.referencePrice) * 100);
        result.electricity = {
          annual,
          monthly: Math.round(annual / 12),
          estimate: priceForPeriod(annual, normalized.period),
          percentVsReference: Math.max(0, vsReference),
          referencePrice: network.referencePrice,
          referenceScheme: network.referenceScheme,
          tariffStructure: tariff.rateCard.structure,
        };
      }
      if (normalized.gas && gasNetwork) {
        const annual = estimateAnnualGas(gasNetwork, plan);
        result.gas = { annual, monthly: Math.round(annual / 12), estimate: priceForPeriod(annual, normalized.period) };
      }
      return result;
    });

    const quoteId = `${QUOTE_PREFIX}-${uuidv4().slice(0, 8).toUpperCase()}`;
    const duration = Date.now() - startTime;

    incrementMetric('plan_pricing.estimate_created', { route: ROUTE, network: site.network, tariff: tariffCode });
    recordTiming('plan_pricing.estimate_latency', duration, { route: ROUTE });

    return {
      success: true,
      quoteId,
      period: normalized.period,
      supplyPoint: {
        state: site.state,
        postcode: site.postcode,
        network: network.label,
        gasNetwork: gasNetwork ? gasNetwork.label : null,
        meterType: site.meterType,
        tariffCode,
      },
      basis: `Based on a household using ${REFERENCE_USAGE.electricityKwhPerYear.toLocaleString('en-AU')} kWh/year in the ${network.label} network (incl. GST).`,
      plans,
      createdAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('plan_pricing.estimate_failure', { route: ROUTE, errorClass: error.name, network: site.network });
    recordTiming('plan_pricing.estimate_latency', duration, { route: ROUTE, error: 'true' });

    logger.error('AGL plan pricing failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      state: site.state,
      network: site.network,
      meterType: site.meterType,
      tariffCode,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        state: site.state,
        network: site.network,
        meter_type: site.meterType,
        alert_path: 'instant',
      },
      extra: { requestId, postcode: site.postcode, tariffCode },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/75d1ea37.js \u2014 estimateAnnualElectricity',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: normalized.devinUserId,
      devinEmail: normalized.devinEmail,
      devinOrgId: normalized.devinOrgId,
      service: SERVICE,
      verticalLabel: 'AGL Energy Plan Pricing',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '75d1ea37',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'state', value: site.state },
        { key: 'network', value: site.network },
        { key: 'meter_type', value: site.meterType },
        { key: 'quote_prefix', value: QUOTE_PREFIX },
      ],
      extra: { requestId, postcode: site.postcode, tariffCode },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@2026.7.0`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for AGL plan pricing error', {
        error: alertError.message,
        requestId,
      });
    });

    error.requestId = requestId;
    throw error;
  }
}

module.exports = {
  estimatePlans,
  resolveSupplyPoint,
  resolveNetworkTariff,
  estimateAnnualElectricity,
  estimateAnnualGas,
  SUPPLY_POINTS,
  NETWORKS,
  NETWORK_TARIFF_ASSIGNMENT,
  RETAIL_RATE_CARDS,
  PLANS,
  REMEDIATION_DIRECTIVE,
};
