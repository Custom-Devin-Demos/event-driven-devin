const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const IMAGE_BASE = 'https://assets.gcs.ehi.com/content/enterprise_cros/data/vehicle/bookingCountries/US/';

/**
 * Vehicle classes published by the Enterprise reservation catalog.
 */
const VEHICLE_CLASSES = [
  { code: 'CFAR', name: 'Compact SUV', model: 'Hyundai Kona or similar', seats: 5, bags: 3, perDay: 81.19, total: 133.32, ratePlan: 'suv_compact_2026', image: `${IMAGE_BASE}SUVS/CFAR.doi.200.high.imageSmallThreeQuarterNodePath.png/1755026990592.png` },
  { code: 'CFDR', name: 'Compact SUV AWD', model: 'Hyundai Kona AWD or similar', seats: 5, bags: 3, perDay: 86.56, total: 140.35, ratePlan: 'suv_compact_awd_2026', image: `${IMAGE_BASE}SUVS/CFDR.doi.200.high.imageSmallThreeQuarterNodePath.png/1755026990592.png` },
  { code: 'IFAR', name: 'Midsize SUV', model: 'Nissan Rogue or similar', seats: 5, bags: 4, perDay: 86.26, total: 140.35, ratePlan: 'suv_midsize_2026', image: `${IMAGE_BASE}SUVS/IFAR.doi.200.high.imageSmallThreeQuarterNodePath.png/1740004522317.png` },
  { code: 'IFDR', name: 'Midsize SUV AWD', model: 'Nissan Rogue AWD or similar', seats: 5, bags: 4, perDay: 89.57, total: 144.55, ratePlan: 'suv_midsize_awd_2026', image: `${IMAGE_BASE}SUVS/IFDR.doi.200.high.imageSmallThreeQuarterNodePath.png/1740004522317.png` },
  { code: 'SFAR', name: 'Standard SUV', model: 'Chevrolet Equinox or similar', seats: 5, bags: 5, perDay: 94.32, total: 158.81, ratePlan: 'suv_standard_2026', image: `${IMAGE_BASE}SUVS/SFAR.doi.200.high.imageSmallThreeQuarterNodePath.png/1755027916679.png` },
  { code: 'ECAR', name: 'Economy', model: 'Mitsubishi Mirage or similar', seats: 4, bags: 2, perDay: 71.44, total: 118.90, ratePlan: 'car_economy_2026', image: `${IMAGE_BASE}CARS/ECAR.doi.200.high.imageSmallThreeQuarterNodePath.png/1747407583249.png` },
  { code: 'CCAR', name: 'Compact', model: 'Nissan Versa or similar', seats: 5, bags: 2, perDay: 73.10, total: 121.66, ratePlan: 'car_compact_2026', image: `${IMAGE_BASE}CARS/CCAR.doi.200.high.imageSmallThreeQuarterNodePath.png/1747407751625.png` },
  { code: 'ICAR', name: 'Midsize', model: 'Toyota Corolla or similar', seats: 5, bags: 3, perDay: 76.55, total: 127.14, ratePlan: 'car_midsize_2026', image: `${IMAGE_BASE}CARS/ICAR.doi.200.high.imageSmallThreeQuarterNodePath.png/1740003621705.png` },
  { code: 'SCAR', name: 'Standard', model: 'Volkswagen Jetta or similar', seats: 5, bags: 3, perDay: 79.90, total: 132.48, ratePlan: 'car_standard_2026', image: `${IMAGE_BASE}CARS/SCAR.doi.200.high.imageSmallThreeQuarterNodePath.png/1740003713013.png` },
  { code: 'FCAR', name: 'Full Size', model: 'Nissan Altima or similar', seats: 5, bags: 4, perDay: 82.75, total: 137.02, ratePlan: 'car_full_size_2026', image: `${IMAGE_BASE}CARS/FCAR.doi.200.high.imageSmallThreeQuarterNodePath.png/1781016474407.png` },
  { code: 'MVAR', name: '7 Passenger Minivan', model: 'Chrysler Pacifica or similar', seats: 7, bags: 5, perDay: 112.66, total: 179.44, ratePlan: 'van_minivan_2026', image: `${IMAGE_BASE}VANS/MVAR.doi.200.high.imageSmallThreeQuarterNodePath.png/1750437904732.png` },
  { code: 'STAR', name: 'Convertible', model: 'Ford Mustang Convertible or similar', seats: 4, bags: 2, perDay: 129.99, total: 208.10, ratePlan: 'car_convertible_2026', image: `${IMAGE_BASE}CARS/STAR.doi.200.high.imageSmallThreeQuarterNodePath.png/1747408500972.png` },
];

/**
 * The 2026 fleet refresh split the Kona line out of ICAR into its own CFAR
 * compact-SUV class. Revenue Management published the class in the booking
 * catalog ahead of the rate-plan load (ticket RM-4471), so airport locations
 * can quote it but the plan row never landed.
 */
const RATE_PLANS = {
  suv_compact_awd_2026: { label: 'Compact SUV AWD', mileagePolicy: 'Limited Mileage', mileageCapMiles: 300, taxRecoveryPct: 0.0925, youngRenterSurchargeUsd: 25, concessionRecoveryPct: 0.105 },
  suv_midsize_2026: { label: 'Midsize SUV', mileagePolicy: 'Unlimited Mileage', mileageCapMiles: null, taxRecoveryPct: 0.0925, youngRenterSurchargeUsd: 25, concessionRecoveryPct: 0.105 },
  suv_midsize_awd_2026: { label: 'Midsize SUV AWD', mileagePolicy: 'Unlimited Mileage', mileageCapMiles: null, taxRecoveryPct: 0.0925, youngRenterSurchargeUsd: 25, concessionRecoveryPct: 0.105 },
  suv_standard_2026: { label: 'Standard SUV', mileagePolicy: 'Unlimited Mileage', mileageCapMiles: null, taxRecoveryPct: 0.0925, youngRenterSurchargeUsd: 25, concessionRecoveryPct: 0.105 },
  car_economy_2026: { label: 'Economy', mileagePolicy: 'Unlimited Mileage', mileageCapMiles: null, taxRecoveryPct: 0.0925, youngRenterSurchargeUsd: 25, concessionRecoveryPct: 0.105 },
  car_compact_2026: { label: 'Compact', mileagePolicy: 'Unlimited Mileage', mileageCapMiles: null, taxRecoveryPct: 0.0925, youngRenterSurchargeUsd: 25, concessionRecoveryPct: 0.105 },
  car_midsize_2026: { label: 'Midsize', mileagePolicy: 'Unlimited Mileage', mileageCapMiles: null, taxRecoveryPct: 0.0925, youngRenterSurchargeUsd: 25, concessionRecoveryPct: 0.105 },
  car_standard_2026: { label: 'Standard', mileagePolicy: 'Unlimited Mileage', mileageCapMiles: null, taxRecoveryPct: 0.0925, youngRenterSurchargeUsd: 25, concessionRecoveryPct: 0.105 },
  car_full_size_2026: { label: 'Full Size', mileagePolicy: 'Unlimited Mileage', mileageCapMiles: null, taxRecoveryPct: 0.0925, youngRenterSurchargeUsd: 25, concessionRecoveryPct: 0.105 },
  van_minivan_2026: { label: '7 Passenger Minivan', mileagePolicy: 'Unlimited Mileage', mileageCapMiles: null, taxRecoveryPct: 0.0925, youngRenterSurchargeUsd: 25, concessionRecoveryPct: 0.105 },
  car_convertible_2026: { label: 'Convertible', mileagePolicy: 'Unlimited Mileage', mileageCapMiles: null, taxRecoveryPct: 0.0925, youngRenterSurchargeUsd: 25, concessionRecoveryPct: 0.105 },
};

const PROTECTION_PRODUCTS = {
  'damage-waiver': { name: 'Damage Waiver', description: 'Protect your wallet and let us protect the car with this optional coverage!', price: 26.99, perRental: false },
  'personal-effects': { name: 'Personal Effects Coverage', description: 'Protect your belongings in the car!', price: 6.60, perRental: false },
  'roadside-protection': { name: 'Roadside Protection', description: 'Get 24/7 roadside assistance (where available) for lost keys, flat tire, and more.', price: 5.99, perRental: false },
  'supplemental-liability': { name: 'Supplemental Liability Protection', description: 'Protects all authorized drivers against third-party claims with up to $300,000 in a combined single limit.', price: 12.95, perRental: false },
};

const EQUIPMENT = {
  'sirius-xm': { name: 'Sirius XM®', description: 'Listen to anything you want, everywhere you drive.', price: 5.99, max: 49.98, perRental: false },
  gps: { name: 'GPS', description: 'Find your destination easier with this GPS device.', price: 15.99, max: 319.99, perRental: false },
  'child-safety-seat': { name: 'Child Safety Seat', description: 'Travel with child safely and securely.', price: 13.99, max: 85.00, perRental: false },
  'baby-seat': { name: 'Baby Seat', description: 'Travel with your baby safely and securely.', price: 13.99, max: 85.00, perRental: false },
  'carbon-offset': { name: 'Carbon Offset Program', description: 'Choose to add on today.', price: 1.25, max: null, perRental: true },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Enterprise Rent-A-Car reservation pricing vertical:',
  '- Service: `app/services/verticals/9562e18a.js`',
  '- Route: `app/routes/verticals/9562e18a.js`',
  '- Page: `app/public/verticals/9562e18a.html` (served at `/9562e18a`)',
  '',
  'Trace the newly onboarded CFAR class through the booking catalog and rate-plan registry. Add coverage so a booking-catalog class without a rate plan cannot be quoted, rather than null-guarding the crash site in `computeTimeAndMileage`.',
  'Open a pull request against `main` with the fix.',
].join('\n');

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function findVehicle(vehicleClass) {
  return VEHICLE_CLASSES.find((vehicle) => vehicle.code === vehicleClass) || null;
}

function rentalDays(pickupAt, returnAt) {
  return Math.max(1, Math.ceil((new Date(returnAt) - new Date(pickupAt)) / (24 * 60 * 60 * 1000)));
}

function computeTimeAndMileage(vehicle, days, plan) {
  const cap = plan.mileageCapMiles;
  return {
    rentalDays: days,
    mileagePolicy: plan.mileagePolicy,
    mileageCapMiles: cap,
    estimatedMiles: cap === null ? 'Unlimited' : Math.min(cap, days * 150),
    dailyRate: vehicle.perDay,
    baseRate: vehicle.total,
  };
}

function buildAddOnLines(ids, catalog, days) {
  return ids
    .map((id) => catalog[id])
    .filter(Boolean)
    .map((item) => ({
      name: item.name,
      price: roundMoney(item.perRental ? item.price : item.price * days),
      unitPrice: item.price,
      unit: item.perRental ? 'Per Rental' : 'Per Day',
    }));
}

function validateReservation(data) {
  if (!data.pickupLocation || !data.pickupLocationCode || !data.pickupAt || !data.returnAt) {
    const error = new Error('Please provide a pick-up location and both rental dates.');
    error.name = 'ValidationError';
    error.code = 'RESERVATION_VALIDATION_FAILED';
    error.statusCode = 400;
    throw error;
  }

  const pickup = new Date(data.pickupAt);
  const returned = new Date(data.returnAt);
  if (Number.isNaN(pickup.getTime()) || Number.isNaN(returned.getTime()) || returned <= pickup) {
    const error = new Error('Return date must be after the pick-up date.');
    error.name = 'ValidationError';
    error.code = 'RESERVATION_VALIDATION_FAILED';
    error.statusCode = 400;
    throw error;
  }

  if (!findVehicle(data.vehicleClass)) {
    const error = new Error('Please select a valid vehicle class.');
    error.name = 'ValidationError';
    error.code = 'RESERVATION_VALIDATION_FAILED';
    error.statusCode = 400;
    throw error;
  }
}

async function reserveVehicle(data) {
  const startTime = Date.now();
  const reservationId = uuidv4();
  const selectedVehicleClass = data.vehicleClass || 'CFAR';
  const protectionProducts = Array.isArray(data.protectionProducts) ? data.protectionProducts : ['damage-waiver'];
  const equipment = Array.isArray(data.equipment) ? data.equipment : [];

  validateReservation({ ...data, vehicleClass: selectedVehicleClass });

  const vehicle = findVehicle(selectedVehicleClass);
  logger.info('Pricing Enterprise reservation', {
    reservationId,
    vehicleClass: selectedVehicleClass,
    pickupLocationCode: data.pickupLocationCode,
    service: 'customer-9562e18a-reservation-pricing',
    route: '/api/9562e18a/reserve',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 90 + Math.random() * 140));

    const days = rentalDays(data.pickupAt, data.returnAt);
    const plan = RATE_PLANS[vehicle.ratePlan];
    const timeAndMileage = computeTimeAndMileage(vehicle, days, plan);
    const protectionLines = buildAddOnLines(protectionProducts, PROTECTION_PRODUCTS, days);
    const equipmentLines = buildAddOnLines(equipment, EQUIPMENT, days);
    const youngRenterSurcharge = data.renterAge === '21-24' || data.renterAge === '18-20'
      ? 25 * days
      : 0;
    const subtotal = vehicle.total + protectionLines.reduce((sum, line) => sum + line.price, 0)
      + equipmentLines.reduce((sum, line) => sum + line.price, 0) + youngRenterSurcharge;
    const taxes = roundMoney(subtotal * 0.0925);
    const result = {
      success: true,
      confirmationNumber: `ENT-${String(Math.floor(100000000 + Math.random() * 900000000))}`,
      status: 'confirmed',
      reservationId,
      vehicle: {
        code: vehicle.code,
        name: vehicle.name,
        model: vehicle.model,
      },
      pickup: {
        location: data.pickupLocation,
        locationCode: data.pickupLocationCode,
        at: data.pickupAt,
      },
      return: { at: data.returnAt },
      timeAndMileage,
      protectionProducts: protectionLines,
      equipment: equipmentLines,
      youngRenterSurcharge: roundMoney(youngRenterSurcharge),
      taxes,
      estimatedTotalUsd: roundMoney(subtotal + taxes),
    };

    const duration = Date.now() - startTime;
    incrementMetric('reservation_pricing.success', {
      route: '/api/9562e18a/reserve',
      vehicleClass: selectedVehicleClass,
    });
    recordTiming('reservation_pricing.latency', duration, {
      route: '/api/9562e18a/reserve',
    });
    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('reservation_pricing.failure', {
      route: '/api/9562e18a/reserve',
      errorClass: error.name,
      vehicleClass: selectedVehicleClass,
    });
    recordTiming('reservation_pricing.latency', duration, {
      route: '/api/9562e18a/reserve',
      error: 'true',
    });
    logger.error('Enterprise reservation pricing failed', {
      reservationId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      vehicleClass: selectedVehicleClass,
      service: 'customer-9562e18a-reservation-pricing',
    });
    Sentry.captureException(error, {
      tags: {
        route: '/api/9562e18a/reserve',
        service: 'customer-9562e18a-reservation-pricing',
        vehicleClass: selectedVehicleClass,
        protectionCount: String(protectionProducts.length),
      },
      extra: {
        reservationId,
        vehicleClass: selectedVehicleClass,
        rentalDays: rentalDays(data.pickupAt, data.returnAt),
        pickupLocationCode: data.pickupLocationCode,
      },
    });
    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/9562e18a.js — computeTimeAndMileage',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-9562e18a-reservation-pricing',
      verticalLabel: 'Car Rental Reservation',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '9562e18a',
      slackMemberId: 'U0BKV8PTK6F',
      tags: [
        { key: 'route', value: '/api/9562e18a/reserve' },
        { key: 'service', value: 'customer-9562e18a-reservation-pricing' },
        { key: 'vehicleClass', value: selectedVehicleClass },
        { key: 'protectionCount', value: String(protectionProducts.length) },
      ],
      extra: {
        reservationId,
        vehicleClass: selectedVehicleClass,
        rentalDays: rentalDays(data.pickupAt, data.returnAt),
        pickupLocationCode: data.pickupLocationCode,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-9562e18a-reservation-pricing@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for reservation pricing error', {
        error: alertError.message,
        reservationId,
      });
    });

    throw error;
  }
}

module.exports = {
  reserveVehicle,
  REMEDIATION_DIRECTIVE,
  VEHICLE_CLASSES,
  RATE_PLANS,
  PROTECTION_PRODUCTS,
  EQUIPMENT,
  computeTimeAndMileage,
};
