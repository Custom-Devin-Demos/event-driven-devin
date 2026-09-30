const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Anthem (Elevance Health) Individual & Family plan catalog.
 * premium is the monthly household USD amount.
 */
const PLAN_CATALOG = [
  { id: 'ANT-MED-GOLD-PPO', planName: 'Anthem Gold PPO 1000', category: 'medical', metalTier: 'Gold', network: 'Pathway PPO', premium: 612.40, coversPediatric: false },
  { id: 'ANT-MED-SILVER-HMO', planName: 'Anthem Silver Pathway HMO 3500', category: 'medical', metalTier: 'Silver', network: 'Pathway HMO', premium: 488.15, coversPediatric: false },
  { id: 'ANT-MED-BRONZE-EPO', planName: 'Anthem Bronze Essential EPO 7500', category: 'medical', metalTier: 'Bronze', network: 'Essential EPO', premium: 356.90, coversPediatric: false },
  { id: 'ANT-DEN-ESSENTIAL', planName: 'Anthem Essential Choice Dental (Adult)', category: 'dental', metalTier: null, network: 'Dental Prime', premium: 38.20, coversPediatric: false },
  { id: 'ANT-DEN-FAMILY', planName: 'Anthem Dental Family Prime', category: 'dental', metalTier: null, network: 'Dental Prime', premium: 64.75, coversPediatric: true },
  { id: 'ANT-VIS-BLUEVIEW', planName: 'Blue View Vision', category: 'vision', metalTier: null, network: 'Blue View Vision', premium: 12.60, coversPediatric: false },
];

/**
 * Anthem Individual & Family states — carrier name and marketplace per state.
 */
const STATES = {
  IN: { carrierName: 'Anthem Blue Cross and Blue Shield', exchange: 'HealthCare.gov' },
  OH: { carrierName: 'Anthem Blue Cross and Blue Shield', exchange: 'HealthCare.gov' },
  GA: { carrierName: 'Anthem Blue Cross and Blue Shield', exchange: 'HealthCare.gov' },
  VA: { carrierName: 'Anthem Blue Cross and Blue Shield', exchange: 'HealthCare.gov' },
  CO: { carrierName: 'Anthem Blue Cross and Blue Shield', exchange: 'Connect for Health Colorado' },
  NY: { carrierName: 'Anthem Blue Cross Blue Shield', exchange: 'NY State of Health' },
  CA: { carrierName: 'Anthem Blue Cross', exchange: 'Covered California' },
};

/**
 * Auto-embeds the ACA pediatric dental essential health benefit when the
 * household includes a child and no selected plan already covers pediatric
 * dental.
 */
function applyRequiredBenefits(items, household) {
  const hasChild = (household || []).some((member) => member.age < 19);
  if (!hasChild) return items;
  const covered = items.some((item) => {
    const plan = PLAN_CATALOG.find((p) => p.id === item.planId);
    return plan && plan.coversPediatric;
  });
  if (covered) return items;
  return [...items, { planId: 'ANT-EHB-PEDDENTAL', premium: 0, embedded: true }];
}

/**
 * Computes the total monthly premium for the selected items.
 */
function computeMonthlyPremium(items, state) {
  if (!Object.prototype.hasOwnProperty.call(STATES, state)) {
    throw Object.assign(new Error(`Unknown state: ${state}`), { code: 'INVALID_STATE' });
  }
  const monthlyPremium = items.reduce((sum, item) => sum + item.premium, 0);
  return {
    monthlyPremium: Math.round(monthlyPremium * 100) / 100,
    carrierName: STATES[state].carrierName,
    exchange: STATES[state].exchange,
  };
}

/**
 * Formats the enrollment summary for the confirmation.
 * BUG: ANT-EHB-PEDDENTAL is not in PLAN_CATALOG, so product.planName crashes.
 */
function formatEnrollmentSummary(allItems) {
  return allItems.map((item) => {
    const product = PLAN_CATALOG.find((p) => p.id === item.planId);
    return {
      planId: item.planId,
      planName: product.planName,
      category: product.category,
      metalTier: product.metalTier,
      network: product.network,
      premium: item.premium,
      embedded: item.embedded === true,
    };
  });
}

/**
 * Processes an Anthem Individual & Family plan enrollment.
 */
async function processEnrollment(data) {
  if (!Object.prototype.hasOwnProperty.call(STATES, data.state)) {
    throw Object.assign(new Error(`Unknown state: ${data.state}`), {
      name: 'ValidationError',
      code: 'INVALID_STATE',
      status: 400,
    });
  }

  const hasMedicalPlan = (data.items || []).some((item) => {
    const plan = PLAN_CATALOG.find((p) => p.id === item.planId);
    return plan && plan.category === 'medical';
  });
  if (!hasMedicalPlan) {
    throw Object.assign(new Error('Enrollment requires a medical plan selection'), {
      name: 'ValidationError',
      code: 'NO_MEDICAL_PLAN',
      status: 400,
    });
  }

  const startTime = Date.now();
  const enrollmentId = uuidv4();

  logger.info('Processing Anthem enrollment', {
    enrollmentId,
    userId: data.userId,
    state: data.state,
    service: 'anthem-enrollment',
    route: '/api/9fdcf315/enroll',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const allItems = applyRequiredBenefits(data.items, data.household);
    const result = computeMonthlyPremium(allItems, data.state);
    const summary = formatEnrollmentSummary(allItems);

    const duration = Date.now() - startTime;

    incrementMetric('enrollment.success', {
      route: '/api/9fdcf315/enroll',
      source: 'anthem-shop',
    });
    recordTiming('enrollment.latency', duration, {
      route: '/api/9fdcf315/enroll',
    });

    return {
      success: true,
      enrollmentId,
      monthlyPremium: result.monthlyPremium,
      carrierName: result.carrierName,
      exchange: result.exchange,
      coverageStart: data.coverageStart,
      summary,
      status: 'confirmed',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('enrollment.failure', {
      route: '/api/9fdcf315/enroll',
      errorClass: error.name,
      source: 'anthem-shop',
    });
    recordTiming('enrollment.latency', duration, {
      route: '/api/9fdcf315/enroll',
      error: 'true',
    });

    logger.error('Anthem enrollment failed', {
      enrollmentId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      userId: data.userId,
      service: 'anthem-enrollment',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/9fdcf315/enroll',
        service: 'anthem-enrollment',
        source: 'anthem-shop',
        alert_path: 'instant',
      },
      extra: {
        enrollmentId,
        userId: data.userId,
        state: data.state,
        coverageStart: data.coverageStart,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/9fdcf315.js — formatEnrollmentSummary',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      customer: '9fdcf315',
      service: 'anthem-enrollment',
      verticalLabel: 'Elevance Health — Anthem Enrollment',
      tags: [
        { key: 'route', value: '/api/9fdcf315/enroll' },
        { key: 'service', value: 'anthem-enrollment' },
      ],
      extra: { enrollmentId, userId: data.userId, state: data.state },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'anthem-enrollment@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Anthem enrollment error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processEnrollment, computeMonthlyPremium, formatEnrollmentSummary, applyRequiredBenefits, PLAN_CATALOG, STATES };
