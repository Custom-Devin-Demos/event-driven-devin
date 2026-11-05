const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const ROUTE = '/api/oncall/shippingrates/rates';
const ORIGIN_TIME_ZONE = 'America/Chicago';
const DIM_DIVISOR = 139;
const MAX_PACKAGES = 300;
const LB_PER_KG = 2.20462;
const CM_PER_IN = 2.54;
const MAX_WEIGHT_LB = 150;

/**
 * Domestic zone chart for shipments from the Memphis, TN (381) hub, keyed by
 * destination ZIP3 range.
 */
const DOMESTIC_ZONES = [
  { from: 370, to: 386, zone: 2 },
  { from: 387, to: 399, zone: 3 },
  { from: 700, to: 729, zone: 3 },
  { from: 300, to: 369, zone: 4 },
  { from: 400, to: 499, zone: 4 },
  { from: 600, to: 699, zone: 4 },
  { from: 730, to: 749, zone: 4 },
  { from: 200, to: 299, zone: 5 },
  { from: 500, to: 599, zone: 5 },
  { from: 750, to: 799, zone: 5 },
  { from: 0, to: 199, zone: 6 },
  { from: 800, to: 899, zone: 7 },
  { from: 900, to: 999, zone: 8 },
];

const ZONE_FACTOR = { 2: 0.62, 3: 0.74, 4: 0.86, 5: 1, 6: 1.12, 7: 1.22, 8: 1.32 };
const GROUND_TRANSIT_DAYS = { 2: 1, 3: 2, 4: 2, 5: 3, 6: 4, 7: 4, 8: 5 };

/**
 * Domestic services with zone-5 list rates (first pound + each additional pound).
 */
const DOMESTIC_SERVICES = [
  { serviceType: 'FIRST_OVERNIGHT', serviceName: 'FedEx First Overnight®', transitDays: 1, deliveryTime: '8:00 AM', base: 128.4, perLb: 9.8 },
  { serviceType: 'PRIORITY_OVERNIGHT', serviceName: 'FedEx Priority Overnight®', transitDays: 1, deliveryTime: '10:30 AM', base: 92.15, perLb: 9.65 },
  { serviceType: 'STANDARD_OVERNIGHT', serviceName: 'FedEx Standard Overnight®', transitDays: 1, deliveryTime: '5:00 PM', base: 83.4, perLb: 8.7 },
  { serviceType: 'FEDEX_2_DAY_AM', serviceName: 'FedEx 2Day® AM', transitDays: 2, deliveryTime: '10:30 AM', base: 41.9, perLb: 5.55 },
  { serviceType: 'FEDEX_2_DAY', serviceName: 'FedEx 2Day®', transitDays: 2, deliveryTime: '5:00 PM', base: 36.15, perLb: 4.8 },
  { serviceType: 'FEDEX_EXPRESS_SAVER', serviceName: 'FedEx Express Saver®', transitDays: 3, deliveryTime: '5:00 PM', base: 31.7, perLb: 3.95 },
  { serviceType: 'FEDEX_GROUND', serviceName: 'FedEx Ground®', transitDays: null, deliveryTime: 'End of day', base: 12.85, perLb: 1.2 },
];

/**
 * International export zones from the US, keyed by destination country.
 * Loaded from the rating-web zone table export.
 */
const INTL_ZONES = {
  MX: { zoneCode: 'C', country: 'Mexico', transitDays: { INTERNATIONAL_PRIORITY: 2, INTERNATIONAL_ECONOMY: 4 } },
  GB: { zoneCode: 'H', country: 'United Kingdom', transitDays: { INTERNATIONAL_PRIORITY: 2, INTERNATIONAL_ECONOMY: 5 } },
};

const INTL_SERVICES = [
  { serviceType: 'INTERNATIONAL_PRIORITY', serviceName: 'FedEx International Priority®', deliveryTime: '5:00 PM', base: { A: 71.2, C: 98.5, H: 128.1 }, perLb: { A: 6.1, C: 8.75, H: 11.4 } },
  { serviceType: 'INTERNATIONAL_ECONOMY', serviceName: 'FedEx International Economy®', deliveryTime: '5:00 PM', base: { A: 62.4, C: 86.3, H: 109.6 }, perLb: { A: 5.2, C: 7.4, H: 9.65 } },
];

const FUEL_SURCHARGE = { express: 0.185, ground: 0.165, international: 0.21 };

function invalid(message) {
  const err = new Error(message);
  err.code = 'INVALID_SHIPMENT';
  return err;
}

function money(n) {
  return Math.round(n * 100) / 100;
}

function toPositiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeAddress(addr, role) {
  if (!addr || typeof addr !== 'object') throw invalid(`Missing ${role} address`);
  const countryCode = String(addr.countryCode || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) throw invalid(`Missing ${role} country`);
  return {
    city: String(addr.city || '').trim().slice(0, 80),
    stateOrProvinceCode: String(addr.stateOrProvinceCode || '').trim().toUpperCase().slice(0, 3),
    postalCode: String(addr.postalCode || '').trim().toUpperCase().slice(0, 10),
    countryCode,
  };
}

function normalizePackages(packages) {
  const list = Array.isArray(packages) && packages.length ? packages : [{}];
  const packageCount = list.reduce((sum, pkg) => sum + (parseInt(pkg.count, 10) || 1), 0);
  if (packageCount > MAX_PACKAGES) throw invalid(`A quote can include at most ${MAX_PACKAGES} packages`);
  return list.map((pkg) => {
    const count = Math.max(parseInt(pkg.count, 10) || 1, 1);
    const weightFactor = String(pkg.weight && pkg.weight.units).toUpperCase() === 'KG' ? LB_PER_KG : 1;
    const weight = toPositiveNumber(pkg.weight && pkg.weight.value) * weightFactor;
    if (!weight || weight > MAX_WEIGHT_LB) throw invalid('Package weight must be between 1 and 150 lb');
    const dims = pkg.dimensions || {};
    const dimFactor = String(dims.units).toUpperCase() === 'CM' ? 1 / CM_PER_IN : 1;
    const length = toPositiveNumber(dims.length) * dimFactor;
    const width = toPositiveNumber(dims.width) * dimFactor;
    const height = toPositiveNumber(dims.height) * dimFactor;
    const dimWeight = length && width && height ? Math.ceil((length * width * height) / DIM_DIVISOR) : 0;
    return { count, weight, billableWeight: Math.max(Math.ceil(weight), dimWeight) };
  });
}

function parseIsoDate(value) {
  const m = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

function addBusinessDays(date, days) {
  const d = new Date(date.getTime());
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) added += 1;
  }
  return d;
}

/**
 * Next business day in the origin hub's time zone, as YYYY-MM-DD.
 */
function defaultShipDate(now = new Date()) {
  const [y, mo, d] = now.toLocaleDateString('en-CA', { timeZone: ORIGIN_TIME_ZONE }).split('-').map(Number);
  return addBusinessDays(new Date(Date.UTC(y, mo - 1, d)), 1).toISOString().slice(0, 10);
}

function formatDeliveryDay(date) {
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function lookupDomesticZone(postalCode) {
  const zip3 = parseInt(String(postalCode).slice(0, 3), 10);
  if (!/^\d{5}/.test(postalCode) || Number.isNaN(zip3)) throw invalid('Enter a valid US ZIP code');
  const row = DOMESTIC_ZONES.find((z) => zip3 >= z.from && zip3 <= z.to);
  return row ? row.zone : 8;
}

function timeRank(label) {
  const m = /^(\d{1,2}):(\d{2}) (AM|PM)$/.exec(label);
  if (!m) return 24 * 60;
  return ((Number(m[1]) % 12) + (m[3] === 'PM' ? 12 : 0)) * 60 + Number(m[2]);
}

function priceFor(base, perLb, packages, factor, fuel) {
  const total = packages.reduce((sum, pkg) => sum + pkg.count * (base + perLb * (pkg.billableWeight - 1)) * factor, 0);
  return money(total * (1 + fuel));
}

function rateDomestic(shipment, packages, shipDate) {
  const zone = lookupDomesticZone(shipment.recipient.postalCode);
  const factor = ZONE_FACTOR[zone];
  return {
    zone: String(zone),
    rates: DOMESTIC_SERVICES.map((svc) => {
      const ground = svc.serviceType === 'FEDEX_GROUND';
      const delivery = addBusinessDays(shipDate, ground ? GROUND_TRANSIT_DAYS[zone] : svc.transitDays);
      return {
        serviceType: svc.serviceType,
        serviceName: svc.serviceName,
        deliveryDate: delivery.toISOString().slice(0, 10),
        deliveryDay: formatDeliveryDay(delivery),
        deliveryTime: svc.deliveryTime,
        amount: priceFor(svc.base, svc.perLb, packages, factor, ground ? FUEL_SURCHARGE.ground : FUEL_SURCHARGE.express),
      };
    }),
  };
}

function rateInternational(shipment, packages, shipDate) {
  const destination = INTL_ZONES[shipment.recipient.countryCode];
  const zoneCode = destination.zoneCode;
  return {
    zone: zoneCode,
    rates: INTL_SERVICES.map((svc) => {
      const delivery = addBusinessDays(shipDate, destination.transitDays[svc.serviceType]);
      return {
        serviceType: svc.serviceType,
        serviceName: svc.serviceName,
        deliveryDate: delivery.toISOString().slice(0, 10),
        deliveryDay: formatDeliveryDay(delivery),
        deliveryTime: svc.deliveryTime,
        amount: priceFor(svc.base[zoneCode], svc.perLb[zoneCode], packages, 1, FUEL_SURCHARGE.international),
      };
    }),
  };
}

/**
 * Quote list rates for every FedEx service between two addresses.
 */
async function quoteRates(request, options = {}) {
  const startTime = Date.now();
  const quoteId = uuidv4();
  const body = request || {};

  logger.info('Quoting shipping rates', {
    quoteId,
    originCountry: body.shipper && body.shipper.countryCode,
    destinationCountry: body.recipient && body.recipient.countryCode,
    packaging: body.packaging,
    service: 'rating-api',
    route: ROUTE,
  });

  let shipment;
  try {
    shipment = {
      shipper: normalizeAddress(body.shipper, 'origin'),
      recipient: normalizeAddress(body.recipient, 'destination'),
    };
    if (shipment.shipper.countryCode !== 'US') throw invalid('Rates are available for shipments from the United States');
    const packages = normalizePackages(body.packages);
    const shipDate = parseIsoDate(body.shipDate) || parseIsoDate(defaultShipDate());

    const result = shipment.recipient.countryCode === 'US'
      ? rateDomestic(shipment, packages, shipDate)
      : rateInternational(shipment, packages, shipDate);

    const duration = Date.now() - startTime;
    incrementMetric('rating.quote.success', { route: ROUTE, destinationCountry: shipment.recipient.countryCode });
    recordTiming('rating.quote.latency', duration, { route: ROUTE });

    return {
      success: true,
      quoteId,
      currency: 'USD',
      shipDate: shipDate.toISOString().slice(0, 10),
      shipDateLabel: shipDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }),
      origin: shipment.shipper,
      destination: shipment.recipient,
      zone: result.zone,
      billableWeight: packages.reduce((sum, pkg) => sum + pkg.count * pkg.billableWeight, 0),
      rates: result.rates.sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate) || timeRank(a.deliveryTime) - timeRank(b.deliveryTime)),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    if (!error.code) error.code = 'RATE_QUOTE_FAILED';

    incrementMetric('rating.quote.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('rating.quote.latency', duration, { route: ROUTE, error: 'true' });
    logger.error('Shipping rate quote failed', {
      quoteId,
      error: error.message,
      errorClass: error.name,
      code: error.code,
      durationMs: duration,
      destinationCountry: shipment && shipment.recipient.countryCode,
    });

    if (error.code !== 'INVALID_SHIPMENT') {
      Sentry.captureException(error, {
        tags: {
          route: ROUTE,
          service: 'rating-api',
          ...(options.synthetic ? { synthetic_probe: 'true' } : {}),
        },
        extra: { quoteId, destination: shipment && shipment.recipient },
      });
    }

    throw error;
  }
}

module.exports = { quoteRates, defaultShipDate, DOMESTIC_SERVICES, INTL_ZONES };
