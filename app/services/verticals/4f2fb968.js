const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Services a customer can request from the Schedule A Repair form. The
 * `bayProgram` is the join key into the service-bay rules below.
 */
const SERVICE_TYPES = [
  {
    code: 'not-sure',
    name: "I'm not sure",
    description: 'Technician diagnostic to identify the needed repair',
    bayProgram: 'general_diagnostic',
  },
  {
    code: 'belts-hoses',
    name: 'Belts & Hoses',
    description: 'Inspection and replacement of drive belts and coolant hoses',
    bayProgram: 'belts_hoses',
  },
  {
    code: 'brake-repair',
    name: 'Brake Repair',
    description: 'Pads, rotors and brake fluid service',
    bayProgram: 'brake_service',
  },
  {
    code: 'oil-lube-filter',
    name: 'Oil, Lube & Filter',
    description: 'Full-service oil change with chassis lube and filter',
    bayProgram: 'oil_lube_filter',
  },
  {
    code: 'tire-rotation',
    name: 'Tire Rotation',
    description: 'Four-wheel rotation with torque and pressure check',
    bayProgram: 'tire_rotation',
  },
  {
    code: 'wheel-alignment',
    name: 'Wheel Alignment',
    description: 'Four-wheel alignment on the Hunter rack',
    bayProgram: 'wheel_alignment',
  },
];

/**
 * Bay rules per service program: which bay the work is booked into, how long
 * the bay is held, the shop labor rate and the booked labor hours. Every
 * service type's `bayProgram` must be registered here.
 */
const SERVICE_BAYS = {
  belts_hoses: {
    label: 'Belts & Hoses',
    bay: 'Bay 2 — General Service',
    bayTimeMinutes: 60,
    laborRate: 118,
    laborHours: 1,
    partsEstimateUsd: 96,
  },
  brake_service: {
    label: 'Brake Repair',
    bay: 'Bay 1 — Brake & Suspension',
    bayTimeMinutes: 120,
    laborRate: 128,
    laborHours: 2,
    partsEstimateUsd: 284,
  },
  oil_lube_filter: {
    label: 'Oil, Lube & Filter',
    bay: 'Bay 4 — Quick Lube',
    bayTimeMinutes: 30,
    laborRate: 98,
    laborHours: 0.5,
    partsEstimateUsd: 42,
  },
  tire_rotation: {
    label: 'Tire Rotation',
    bay: 'Bay 5 — Tire Service',
    bayTimeMinutes: 30,
    laborRate: 98,
    laborHours: 0.5,
    partsEstimateUsd: 0,
  },
  wheel_alignment: {
    label: 'Wheel Alignment',
    bay: 'Bay 3 — Alignment Rack',
    bayTimeMinutes: 75,
    laborRate: 128,
    laborHours: 1.25,
    partsEstimateUsd: 0,
  },
};

/**
 * Whether the customer waits in the lobby or drops the vehicle off, and the
 * shop-supply surcharge each option carries.
 */
const WAIT_PREFERENCES = {
  wait: { label: 'Waiting in lobby', shopSuppliesUsd: 12 },
  'drop-off': { label: 'Vehicle drop-off', shopSuppliesUsd: 0 },
};

const GA_SALES_TAX_RATE = 0.0775;

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Canada Tire Company Schedule A Repair vertical:',
  '- Service: `app/services/verticals/4f2fb968.js`',
  '- Route: `app/routes/verticals/4f2fb968.js`',
  '- Page: `app/public/verticals/4f2fb968.html` (served at `/canadatire`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function findServiceType(serviceCode) {
  return SERVICE_TYPES.find((type) => type.code === serviceCode) || SERVICE_TYPES[0];
}

function findWaitPreference(preference) {
  return WAIT_PREFERENCES[preference] || WAIT_PREFERENCES['drop-off'];
}

/**
 * Reserve the bay for the requested drop-off time and derive the release time
 * from the service program's bay hold.
 */
function reserveBay(serviceType, requestedStartIso) {
  const rules = SERVICE_BAYS[serviceType.bayProgram];

  const start = new Date(requestedStartIso);
  const end = new Date(start.getTime() + rules.bayTimeMinutes * 60000);

  return {
    program: rules.label,
    bay: rules.bay,
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    bayTimeMinutes: rules.bayTimeMinutes,
  };
}

/**
 * Work-order estimate the customer sees before the technician confirms.
 */
function buildEstimate(serviceType, waitPreference) {
  const rules = SERVICE_BAYS[serviceType.bayProgram];
  const preference = findWaitPreference(waitPreference);

  const laborUsd = Number((rules.laborRate * rules.laborHours).toFixed(2));
  const subtotalUsd = Number((laborUsd + rules.partsEstimateUsd + preference.shopSuppliesUsd).toFixed(2));
  const taxUsd = Number((subtotalUsd * GA_SALES_TAX_RATE).toFixed(2));

  return {
    currency: 'USD',
    laborRate: rules.laborRate,
    laborHours: rules.laborHours,
    laborUsd,
    partsEstimateUsd: rules.partsEstimateUsd,
    shopSuppliesUsd: preference.shopSuppliesUsd,
    taxUsd,
    totalUsd: Number((subtotalUsd + taxUsd).toFixed(2)),
  };
}

/**
 * Assemble the confirmation shown on the Schedule A Repair page.
 */
function buildRequestResult(requestNumber, serviceType, vehicle, appointment, estimate, waitPreference) {
  return {
    requestNumber,
    status: 'requested',
    service: {
      code: serviceType.code,
      name: serviceType.name,
    },
    vehicle,
    appointment,
    estimate,
    waitPreference: findWaitPreference(waitPreference).label,
    location: 'Canada Tire Company \u2014 2965-B2 Holcomb Bridge Rd., Alpharetta, GA 30022',
    callbackWithinHours: 24,
  };
}

/**
 * Submits a Schedule A Repair service request and returns the confirmation.
 */
async function scheduleRepair(data) {
  const startTime = Date.now();
  const requestNumber = `CTC-${uuidv4().slice(0, 8).toUpperCase()}`;

  const customerName = String(data.customerName || '').trim();
  const email = String(data.email || '').trim();
  const firstChoiceStart = String(data.firstChoiceStart || '').trim();
  const parsedStart = new Date(firstChoiceStart);

  if (!customerName || !email || !firstChoiceStart || Number.isNaN(parsedStart.getTime())) {
    const validationError = new Error('Enter your name, email and a first choice appointment date and time.');
    validationError.name = 'ValidationError';
    validationError.code = 'INVALID_SERVICE_REQUEST';
    validationError.statusCode = 400;
    throw validationError;
  }

  logger.info('Submitting Canada Tire service request', {
    requestNumber,
    serviceCode: data.serviceCode,
    waitPreference: data.waitPreference,
    service: 'customer-4f2fb968-service-scheduling',
    route: '/api/4f2fb968/schedule-repair',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 90 + Math.random() * 140));

    const serviceType = findServiceType(data.serviceCode);
    const appointment = reserveBay(serviceType, firstChoiceStart);
    const estimate = buildEstimate(serviceType, data.waitPreference);
    const vehicle = {
      year: (data.vehicle && data.vehicle.year) || '2021',
      make: (data.vehicle && data.vehicle.make) || 'Honda',
      model: (data.vehicle && data.vehicle.model) || 'Accord',
      option: (data.vehicle && data.vehicle.option) || 'Sport 4dr Sedan',
    };
    const result = buildRequestResult(
      requestNumber,
      serviceType,
      vehicle,
      appointment,
      estimate,
      data.waitPreference
    );

    const duration = Date.now() - startTime;

    incrementMetric('service_scheduling.request_success', {
      route: '/api/4f2fb968/schedule-repair',
      serviceCode: serviceType.code,
      waitPreference: data.waitPreference || 'drop-off',
    });
    recordTiming('service_scheduling.request_latency', duration, {
      route: '/api/4f2fb968/schedule-repair',
    });

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('service_scheduling.request_failure', {
      route: '/api/4f2fb968/schedule-repair',
      errorClass: error.name,
      serviceCode: data.serviceCode,
    });
    recordTiming('service_scheduling.request_latency', duration, {
      route: '/api/4f2fb968/schedule-repair',
      error: 'true',
    });

    logger.error('Service request submission failed', {
      requestNumber,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      serviceCode: data.serviceCode,
      waitPreference: data.waitPreference,
      service: 'customer-4f2fb968-service-scheduling',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/4f2fb968/schedule-repair',
        service: 'customer-4f2fb968-service-scheduling',
        serviceCode: data.serviceCode,
      },
      extra: {
        requestNumber,
        waitPreference: data.waitPreference,
        firstChoiceStart: data.firstChoiceStart,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/4f2fb968.js \u2014 reserveBay',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-4f2fb968-service-scheduling',
      verticalLabel: 'Service Scheduling',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '4f2fb968',
      slackMemberId: 'U0BKV8PTK6F',
      tags: [
        { key: 'route', value: '/api/4f2fb968/schedule-repair' },
        { key: 'service', value: 'customer-4f2fb968-service-scheduling' },
        { key: 'serviceCode', value: data.serviceCode },
        { key: 'waitPreference', value: data.waitPreference },
      ],
      extra: {
        requestNumber,
        waitPreference: data.waitPreference,
        firstChoiceStart: data.firstChoiceStart,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-4f2fb968-service-scheduling@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for service scheduling error', {
        error: err.message,
        requestNumber,
      });
    });

    throw error;
  }
}

module.exports = {
  scheduleRepair,
  REMEDIATION_DIRECTIVE,
  SERVICE_TYPES,
  SERVICE_BAYS,
  WAIT_PREFERENCES,
};
