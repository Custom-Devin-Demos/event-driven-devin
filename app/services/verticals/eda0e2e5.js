const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/eda0e2e5/orders';
const SERVICE = 'lillydirect-selfpay-order-service';
const SLACK_MEMBER_ID = process.env.LILLY_SLACK_MEMBER_ID || 'U08S7AVJ478';

/**
 * Zepbound single-dose vials dispensed through LillyDirect Self Pay Pharmacy
 * Solutions. One fill is a 28-day supply: four once-weekly vials. The 12.5 mg
 * and 15 mg vials were added to the channel in the 2025-Q3 launch.
 */
const VIAL_CATALOG = {
  '2.5': { strengthMg: 2.5, ndc: '0002-2506-80', label: 'Zepbound 2.5 mg/0.5 mL vial', role: 'starter', vialsPerFill: 4, launched: '2024-08-27' },
  5: { strengthMg: 5, ndc: '0002-2495-80', label: 'Zepbound 5 mg/0.5 mL vial', role: 'titration', vialsPerFill: 4, launched: '2024-08-27' },
  7.5: { strengthMg: 7.5, ndc: '0002-2460-80', label: 'Zepbound 7.5 mg/0.5 mL vial', role: 'titration', vialsPerFill: 4, launched: '2025-02-25' },
  10: { strengthMg: 10, ndc: '0002-2471-80', label: 'Zepbound 10 mg/0.5 mL vial', role: 'maintenance', vialsPerFill: 4, launched: '2025-02-25' },
  12.5: { strengthMg: 12.5, ndc: '0002-2482-80', label: 'Zepbound 12.5 mg/0.5 mL vial', role: 'maintenance', vialsPerFill: 4, launched: '2025-08-04' },
  15: { strengthMg: 15, ndc: '0002-2493-80', label: 'Zepbound 15 mg/0.5 mL vial', role: 'maintenance', vialsPerFill: 4, launched: '2025-08-04' },
};

/** Titration steps a prescriber can move a patient between (2.5 mg increments). */
const TITRATION_STEP_MG = 2.5;

/**
 * Self Pay Journey Program pricing per 28-day fill. `listPrice` is the
 * regular self-pay price; `journeyPrice` applies to the first fill and to
 * refills delivered within `refillWindowDays` of the prior delivery.
 * BUG: VIAL_CATALOG gained the 12.5 mg and 15 mg vials in the 2025-Q3 launch
 * but this schedule was never extended past 10 mg, so pricing those doses
 * resolves `undefined`.
 */
const SELF_PAY_PRICING = {
  '2.5': { listPrice: 349, journeyPrice: 349, refillWindowDays: null, program: 'Starter dose — flat price' },
  5: { listPrice: 499, journeyPrice: 499, refillWindowDays: null, program: 'Self Pay Journey — flat price' },
  7.5: { listPrice: 599, journeyPrice: 499, refillWindowDays: 45, program: 'Self Pay Journey — refill within 45 days' },
  10: { listPrice: 699, journeyPrice: 499, refillWindowDays: 45, program: 'Self Pay Journey — refill within 45 days' },
};

const FILL_TYPES = {
  first_fill: { label: 'First fill', description: 'First shipment at this strength' },
  refill: { label: 'Refill', description: 'Continuing at the same strength' },
  dose_increase: { label: 'Dose increase', description: 'Provider moved you up one 2.5 mg step' },
};

const SHIPPING_OPTIONS = {
  standard: { label: 'Standard cold-chain (2-day)', transitDays: 2, fee: 0 },
  expedited: { label: 'Expedited cold-chain (next-day)', transitDays: 1, fee: 24 },
};

/**
 * Dispensing pharmacies in the LillyDirect network, by the states each ships
 * temperature-controlled shipments into.
 */
const DISPENSING_PHARMACIES = {
  'ph-ind': { name: 'LillyDirect Pharmacy — Indianapolis', shipsTo: ['IN', 'OH', 'IL', 'MI', 'KY', 'TN', 'MO', 'WI', 'MN'], cutoffHourLocal: 14 },
  'ph-phx': { name: 'LillyDirect Pharmacy — Phoenix', shipsTo: ['AZ', 'CA', 'NV', 'UT', 'CO', 'NM', 'TX', 'OR', 'WA'], cutoffHourLocal: 13 },
  'ph-rdu': { name: 'LillyDirect Pharmacy — Raleigh', shipsTo: ['NC', 'SC', 'GA', 'FL', 'VA', 'MD', 'PA', 'NJ', 'NY', 'MA', 'CT'], cutoffHourLocal: 15 },
};

/** States the self-pay channel currently ships to. */
const SHIP_TO_STATES = Object.values(DISPENSING_PHARMACIES).flatMap((p) => p.shipsTo).sort();

const MAX_REFILL_GAP_DAYS = 180;

function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function daysBetween(fromIso, toDate) {
  const from = new Date(`${fromIso}T00:00:00Z`);
  return Math.floor((toDate.getTime() - from.getTime()) / 86400000);
}

function strengthKey(strengthMg) {
  return String(strengthMg);
}

function resolveVial(strengthMg) {
  const vial = VIAL_CATALOG[strengthKey(strengthMg)];
  if (!vial) {
    throw Object.assign(new Error(`Unsupported vial strength: ${strengthMg} mg`), { code: 'INVALID_STRENGTH' });
  }
  return vial;
}

/** The strength a dose-increase order steps up from. */
function previousStrength(strengthMg) {
  const prior = Math.round((strengthMg - TITRATION_STEP_MG) * 10) / 10;
  return Object.hasOwn(VIAL_CATALOG, strengthKey(prior)) ? prior : null;
}

function pharmacyFor(stateCode) {
  const entry = Object.entries(DISPENSING_PHARMACIES).find(([, p]) => p.shipsTo.includes(stateCode));
  if (!entry) {
    throw Object.assign(new Error(`LillyDirect does not ship to ${stateCode}`), { code: 'UNSUPPORTED_STATE' });
  }
  const [pharmacyId, pharmacy] = entry;
  return { pharmacyId, ...pharmacy };
}

/**
 * Whether a refill lands inside the program's refill window. First fills and
 * dose increases always start a fresh window.
 */
function refillStatus(fillType, priorDeliveryDate, now = new Date()) {
  if (fillType !== 'refill') return { daysSincePrior: null, withinWindow: true };
  const daysSincePrior = daysBetween(priorDeliveryDate, now);
  return { daysSincePrior, withinWindow: daysSincePrior <= 45 };
}

/**
 * Prices one 28-day fill under the Self Pay Journey Program.
 * BUG: SELF_PAY_PRICING has no 12.5 or 15 entry, so `pricing.listPrice` crashes.
 */
function priceFill(vial, fillType, status, shipping) {
  const pricing = SELF_PAY_PRICING[strengthKey(vial.strengthMg)];
  const listPrice = pricing.listPrice;
  const programEligible = pricing.refillWindowDays === null || fillType !== 'refill' || status.withinWindow;
  const medicationPrice = programEligible ? pricing.journeyPrice : listPrice;
  const shippingFee = SHIPPING_OPTIONS[shipping].fee;
  return {
    program: pricing.program,
    listPrice,
    journeyPrice: pricing.journeyPrice,
    programEligible,
    medicationPrice,
    programSavings: listPrice - medicationPrice,
    shippingFee,
    total: medicationPrice + shippingFee,
    perVial: Math.round((medicationPrice / vial.vialsPerFill) * 100) / 100,
    refillWindowDays: pricing.refillWindowDays,
  };
}

function estimatedDelivery(pharmacy, shipping, now = new Date()) {
  const opt = SHIPPING_OPTIONS[shipping];
  const shipsToday = now.getUTCHours() < pharmacy.cutoffHourLocal + 5;
  const shipDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + (shipsToday ? 0 : 1)));
  const delivery = new Date(shipDate.getTime() + opt.transitDays * 86400000);
  return { shipDate: shipDate.toISOString().slice(0, 10), deliveryDate: delivery.toISOString().slice(0, 10) };
}

function nextRefillDue(deliveryDate) {
  const d = new Date(`${deliveryDate}T00:00:00Z`);
  return new Date(d.getTime() + 28 * 86400000).toISOString().slice(0, 10);
}

/**
 * Places a Zepbound vial order through the LillyDirect self-pay channel:
 * confirms the strength, prices the fill, routes it to a dispensing pharmacy
 * and returns the order confirmation.
 */
async function placeVialOrder(data) {
  const startTime = Date.now();
  const orderId = `LD-${uuidv4().slice(0, 8).toUpperCase()}`;

  logger.info('Placing LillyDirect self-pay vial order', {
    orderId,
    strengthMg: data.strengthMg,
    fillType: data.fillType,
    state: data.state,
    shipping: data.shipping,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const vial = resolveVial(data.strengthMg);
    const pharmacy = pharmacyFor(data.state);
    const status = refillStatus(data.fillType, data.priorDeliveryDate);
    const pricing = priceFill(vial, data.fillType, status, data.shipping);
    const timeline = estimatedDelivery(pharmacy, data.shipping);

    const duration = Date.now() - startTime;

    incrementMetric('lillydirect.vial_order.success', {
      route: ROUTE,
      strengthMg: String(data.strengthMg),
      fillType: data.fillType,
      state: data.state,
      pharmacy: pharmacy.pharmacyId,
    });
    recordTiming('lillydirect.vial_order.latency', duration, { route: ROUTE });

    return {
      success: true,
      orderId,
      patient: { firstName: data.patientFirstName, state: data.state, zip: data.zip },
      prescription: {
        prescriber: data.prescriberName,
        rxNumber: data.rxNumber,
        medication: vial.label,
        strengthMg: vial.strengthMg,
        ndc: vial.ndc,
        quantity: `${vial.vialsPerFill} single-dose vials (28-day supply)`,
        sig: `Inject ${vial.strengthMg} mg subcutaneously once weekly`,
      },
      fill: {
        type: FILL_TYPES[data.fillType].label,
        steppedUpFrom: data.fillType === 'dose_increase' ? previousStrength(vial.strengthMg) : null,
        daysSincePrior: status.daysSincePrior,
        withinRefillWindow: status.withinWindow,
      },
      pricing,
      fulfillment: {
        pharmacy: pharmacy.name,
        pharmacyId: pharmacy.pharmacyId,
        shipping: SHIPPING_OPTIONS[data.shipping].label,
        shipDate: timeline.shipDate,
        estimatedDelivery: timeline.deliveryDate,
        coldChain: 'Insulated shipper with gel packs — refrigerate on arrival (36–46°F)',
        nextRefillDue: nextRefillDue(timeline.deliveryDate),
      },
      status: 'order_confirmed',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('lillydirect.vial_order.failure', {
      route: ROUTE,
      errorClass: error.name,
      strengthMg: String(data.strengthMg),
      fillType: data.fillType,
    });
    recordTiming('lillydirect.vial_order.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('LillyDirect self-pay vial order failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      strengthMg: data.strengthMg,
      fillType: data.fillType,
      state: data.state,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, source: 'lillydirect-patient-portal', alert_path: 'instant' },
      extra: {
        orderId,
        strengthMg: data.strengthMg,
        fillType: data.fillType,
        state: data.state,
        shipping: data.shipping,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/eda0e2e5.js \u2014 priceFill',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: 'eda0e2e5',
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      service: SERVICE,
      verticalLabel: 'Lilly \u2014 LillyDirect Self Pay Vial Order',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'strength_mg', value: String(data.strengthMg) },
        { key: 'fill_type', value: data.fillType },
      ],
      extra: {
        orderId,
        strengthMg: data.strengthMg,
        fillType: data.fillType,
        state: data.state,
        shipping: data.shipping,
      },
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
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from LillyDirect order error', { error: err.message });
    });

    throw error;
  }
}

module.exports = {
  placeVialOrder,
  resolveVial,
  previousStrength,
  pharmacyFor,
  refillStatus,
  priceFill,
  estimatedDelivery,
  isCalendarDate,
  daysBetween,
  VIAL_CATALOG,
  SELF_PAY_PRICING,
  FILL_TYPES,
  SHIPPING_OPTIONS,
  DISPENSING_PHARMACIES,
  SHIP_TO_STATES,
  TITRATION_STEP_MG,
  MAX_REFILL_GAP_DAYS,
};
