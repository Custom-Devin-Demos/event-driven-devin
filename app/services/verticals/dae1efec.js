const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Kidney Smart education classes a visitor can register for from the
 * homepage. The `classCode` is the join key used at registration time.
 */
const CLASS_CATALOG = [
  {
    classCode: 'ks-intro-101',
    title: 'Kidney Smart: Understanding Kidney Disease',
    durationMinutes: 90,
    educator: 'Renee M., RN, Certified Kidney Educator',
    format: 'in_person',
  },
  {
    classCode: 'ks-nutrition-201',
    title: 'Kidney Smart: Eating Well With CKD',
    durationMinutes: 75,
    educator: 'Marcus T., RD, Renal Dietitian',
    format: 'virtual',
  },
];

/**
 * Delivery rules per class format: how sessions are staffed, what materials
 * ship to the attendee, and the scheduling lead time.
 */
const DELIVERY_FORMATS = {
  in_person: {
    label: 'In-person at a local center',
    educatorPool: 'regional-center-educators',
    materialsKit: 'printed-workbook',
    leadTimeDays: 5,
  },
  virtual: {
    label: 'Live online class',
    educatorPool: 'national-virtual-educators',
    materialsKit: 'digital-workbook',
    leadTimeDays: 2,
  },
};

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the kidney care education vertical:',
  '- Service: `app/services/verticals/dae1efec.js`',
  '- Route: `app/routes/verticals/dae1efec.js`',
  '- Page: `app/public/verticals/dae1efec.html` (served at `/dae1efec`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function findClass(classCode) {
  return CLASS_CATALOG.find((entry) => entry.classCode === classCode) || CLASS_CATALOG[0];
}

/**
 * Resolve the attendee's delivery preference into the descriptor used for
 * scheduling downstream.
 */
function resolveDeliveryPreference(requestedFormat, classEntry) {
  const format = requestedFormat || classEntry.format;
  const rules = DELIVERY_FORMATS[format] || DELIVERY_FORMATS.in_person;
  return {
    mode: format,
    label: rules.label,
    leadTimeDays: rules.leadTimeDays,
  };
}

/**
 * Normalize the raw registration request into the shape the scheduler
 * consumes.
 */
function normalizeRegistration(data, classEntry) {
  return {
    classCode: classEntry.classCode,
    zipCode: String(data.zipCode || '80202').trim(),
    delivery: resolveDeliveryPreference(data.format, classEntry),
    requestedAt: new Date().toISOString(),
  };
}

/**
 * Book the class session: assign an educator pool, queue the materials kit
 * and compute the earliest available session date.
 */
function scheduleClassSession(registration, classEntry) {
  const rules = DELIVERY_FORMATS[registration.delivery];
  const earliest = new Date(Date.now() + rules.leadTimeDays * 86400000);

  return {
    classCode: classEntry.classCode,
    title: classEntry.title,
    educator: classEntry.educator,
    educatorPool: rules.educatorPool,
    materialsKit: rules.materialsKit,
    deliveryLabel: rules.label,
    earliestSessionAt: earliest.toISOString(),
  };
}

/**
 * Assemble the confirmation shown to the visitor.
 */
function buildConfirmation(confirmationNumber, registration, session) {
  return {
    confirmationNumber,
    status: 'registered',
    classCode: session.classCode,
    title: session.title,
    educator: session.educator,
    delivery: session.deliveryLabel,
    materialsKit: session.materialsKit,
    zipCode: registration.zipCode,
    earliestSessionAt: session.earliestSessionAt,
    reminderEmailQueued: true,
  };
}

/**
 * Registers a visitor for a no-cost kidney health education class.
 */
async function registerForClass(data) {
  const startTime = Date.now();
  const confirmationNumber = `KS-${uuidv4().slice(0, 8).toUpperCase()}`;

  logger.info('Registering visitor for kidney health class', {
    confirmationNumber,
    classCode: data.classCode,
    format: data.format,
    service: 'customer-dae1efec-class-registration',
    route: '/api/dae1efec/class-registration',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const classEntry = findClass(data.classCode);
    const registration = normalizeRegistration(data, classEntry);
    const session = scheduleClassSession(registration, classEntry);
    const result = buildConfirmation(confirmationNumber, registration, session);

    const duration = Date.now() - startTime;

    incrementMetric('class_registration.success', {
      route: '/api/dae1efec/class-registration',
      classCode: classEntry.classCode,
    });
    recordTiming('class_registration.latency', duration, {
      route: '/api/dae1efec/class-registration',
    });

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('class_registration.failure', {
      route: '/api/dae1efec/class-registration',
      errorClass: error.name,
      classCode: data.classCode,
    });
    recordTiming('class_registration.latency', duration, {
      route: '/api/dae1efec/class-registration',
      error: 'true',
    });

    logger.error('Class registration failed', {
      confirmationNumber,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      classCode: data.classCode,
      format: data.format,
      service: 'customer-dae1efec-class-registration',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/dae1efec/class-registration',
        service: 'customer-dae1efec-class-registration',
        classCode: data.classCode,
      },
      extra: {
        confirmationNumber,
        format: data.format,
        zipCode: data.zipCode,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/dae1efec.js \u2014 scheduleClassSession',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId || process.env.DEVIN_USER_ID_DAE1EFEC || '',
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId || 'org-fc671f6a07784d4c8563e2ef757343cd',
      service: 'customer-dae1efec-class-registration',
      verticalLabel: 'Kidney Care Education',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 'dae1efec',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/dae1efec/class-registration' },
        { key: 'service', value: 'customer-dae1efec-class-registration' },
        { key: 'classCode', value: data.classCode },
        { key: 'format', value: data.format },
      ],
      extra: {
        confirmationNumber,
        format: data.format,
        zipCode: data.zipCode,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-dae1efec-class-registration@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for class registration error', {
        error: err.message,
        confirmationNumber,
      });
    });

    throw error;
  }
}

module.exports = {
  registerForClass,
  CLASS_CATALOG,
  DELIVERY_FORMATS,
  REMEDIATION_DIRECTIVE,
};
