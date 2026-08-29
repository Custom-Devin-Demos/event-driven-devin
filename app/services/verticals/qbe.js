const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const POLICIES = {
  'QBE-PA-4417293': {
    policyNumber: 'QBE-PA-4417293',
    insuredName: 'Marcus Ellison',
    state: 'NY',
    coverageTierCode: 'premier_auto_2026',
    coverageTierLabel: 'Premier Auto (2026)',
    vehicles: [
      { vin: '1HGCV1F34LA015872', label: '2021 Honda Accord EX-L' },
      { vin: '5TDZA23C13S012345', label: '2019 Toyota Sienna LE' },
    ],
  },
  'QBE-PA-2210884': {
    policyNumber: 'QBE-PA-2210884',
    insuredName: 'Dana Whitfield',
    state: 'NJ',
    coverageTierCode: 'standard_auto',
    coverageTierLabel: 'Standard Auto',
    vehicles: [
      { vin: '3FA6P0H73HR201884', label: '2017 Ford Fusion SE' },
    ],
  },
  'QBE-PA-9038156': {
    policyNumber: 'QBE-PA-9038156',
    insuredName: 'Priya Raman',
    state: 'CT',
    coverageTierCode: 'preferred_auto',
    coverageTierLabel: 'Preferred Auto',
    vehicles: [
      { vin: 'WBA8E9G59GNT80815', label: '2020 BMW 330i xDrive' },
    ],
  },
};

// Deductible schedules registered with the claims platform, keyed by the
// coverage tier code carried on the policy.
const DEDUCTIBLE_SCHEDULES = {
  standard_auto: {
    label: 'Standard Auto',
    collisionDeductible: 1000,
    comprehensiveDeductible: 1000,
    glassDeductible: 250,
    rentalPerDay: 35,
    adjusterQueue: 'auto-standard',
  },
  preferred_auto: {
    label: 'Preferred Auto',
    collisionDeductible: 500,
    comprehensiveDeductible: 500,
    glassDeductible: 100,
    rentalPerDay: 50,
    adjusterQueue: 'auto-preferred',
  },
  // premier_auto_2026 ships with the 2026 book roll-out; schedule registration pending
};

const INCIDENT_TYPES = {
  collision: {
    label: 'Collision',
    coverageCode: 'collision',
    laborHours: 18,
    partsCost: 2850,
    severity: 'high',
  },
  hail: {
    label: 'Hail Damage',
    coverageCode: 'comprehensive',
    laborHours: 9,
    partsCost: 950,
    severity: 'medium',
  },
  theft: {
    label: 'Vehicle Theft',
    coverageCode: 'comprehensive',
    laborHours: 6,
    partsCost: 4200,
    severity: 'critical',
  },
  glass: {
    label: 'Glass Damage',
    coverageCode: 'glass',
    laborHours: 3,
    partsCost: 680,
    severity: 'low',
  },
  water: {
    label: 'Water Damage',
    coverageCode: 'comprehensive',
    laborHours: 14,
    partsCost: 1900,
    severity: 'high',
  },
};

const ADJUSTERS = [
  {
    id: 'ADJ-201',
    name: 'Jordan Blake',
    phone: '(212) 555-0147',
    adjusterQueue: 'auto-standard',
  },
  {
    id: 'ADJ-202',
    name: 'Taylor Morgan',
    phone: '(201) 555-0183',
    adjusterQueue: 'auto-preferred',
  },
  {
    id: 'ADJ-203',
    name: 'Casey Nguyen',
    phone: '(203) 555-0164',
    adjusterQueue: 'auto-preferred',
  },
];

const REMEDIATION_DIRECTIVE = `Repository: COG-GTM/event-driven-devin. The failing surface is the QBE North America claims portal at app/public/verticals/qbe.html (page route GET /qbe), whose "Submit Claim" action posts to POST /api/qbe/claim in app/routes/verticals/qbe.js. The claims estimate pipeline lives in app/services/verticals/qbe.js: submitClaim -> calculateAdjusterEstimate -> resolveDeductibleSchedule. Start at resolveDeductibleSchedule: it looks up DEDUCTIBLE_SCHEDULES by the coverage tier code carried on the policy, and the premier_auto_2026 tier shipped with the 2026 book roll-out without a registered deductible schedule, so the lookup returns undefined and calculateAdjusterEstimate dereferences it while applying the collision deductible. Register the missing coverage tier's deductible schedule and make the lookup fail as a handled claims error routed to an adjuster instead of a TypeError. Do not change the page's look and feel, and do not touch the other verticals' intentional bugs. Verify by starting the server (node app/server.js) and POSTing a collision claim for policy QBE-PA-4417293 to /api/qbe/claim, which must return a successful estimate, and confirm npm run lint passes.`;

function resolveDeductibleSchedule(policy) {
  return DEDUCTIBLE_SCHEDULES[policy.coverageTierCode];
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function calculateRepairEstimate(incident, vehicle) {
  const laborRate = 145;
  const laborCost = incident.laborHours * laborRate;
  const subtotal = laborCost + incident.partsCost;

  return {
    vehicle: vehicle.label,
    laborHours: incident.laborHours,
    laborRate,
    laborCost: roundMoney(laborCost),
    partsCost: roundMoney(incident.partsCost),
    subtotal: roundMoney(subtotal),
  };
}

function assignAdjuster(schedule, _incident) {
  return ADJUSTERS.find((adjuster) => adjuster.adjusterQueue === schedule.adjusterQueue);
}

function calculateAdjusterEstimate(policy, incident, vehicle) {
  const schedule = resolveDeductibleSchedule(policy);
  let deductible;

  if (incident.coverageCode === 'glass') {
    deductible = schedule.glassDeductible;
  } else if (incident.coverageCode === 'comprehensive') {
    deductible = schedule.comprehensiveDeductible;
  } else {
    deductible = schedule.collisionDeductible;
  }

  const repairEstimate = calculateRepairEstimate(incident, vehicle);
  const adjuster = assignAdjuster(schedule, incident);

  return {
    schedule,
    repairEstimate,
    deductible,
    estimatedPayout: roundMoney(Math.max(repairEstimate.subtotal - deductible, 0)),
    adjuster,
  };
}

function validationError(message) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = 'INVALID_CLAIM';
  error.statusCode = 400;
  return error;
}

async function submitClaim(data) {
  const startTime = Date.now();
  const claimNumber = `QBE-CLM-${uuidv4().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
  const policyNumber = data.policyNumber;
  const incidentType = data.incidentType;
  const incidentDate = data.incidentDate;
  const policy = POLICIES[policyNumber];
  const incident = INCIDENT_TYPES[incidentType];

  if (!policyNumber || !String(policyNumber).trim() || !policy) {
    throw validationError(`Unknown policy number: ${policyNumber || '(none)'}`);
  }
  if (!incident) {
    throw validationError(`Unknown incident type: ${incidentType || '(none)'}`);
  }
  if (!data.damageDescription || !String(data.damageDescription).trim()) {
    throw validationError('Damage description is required');
  }
  if (!incidentDate) {
    throw validationError('Incident date is required');
  }

  const vehicle = policy.vehicles.find((candidate) => candidate.vin === data.vin)
    || policy.vehicles[0];

  logger.info('Submitting QBE auto claim', {
    claimNumber,
    policyNumber,
    incidentType,
    incidentDate,
    service: 'customer-qbe-claim',
    route: '/api/qbe/claim',
  });

  try {
    const estimate = calculateAdjusterEstimate(policy, incident, vehicle);
    const inspectionDate = new Date(`${incidentDate}T15:00:00.000Z`);
    inspectionDate.setUTCDate(inspectionDate.getUTCDate() + 3);
    const submittedAt = new Date().toISOString();
    const duration = Date.now() - startTime;

    incrementMetric('qbe_claim.success', {
      route: '/api/qbe/claim',
      incidentType,
      coverageTier: policy.coverageTierCode,
    });
    recordTiming('qbe_claim.latency', duration, {
      route: '/api/qbe/claim',
    });

    return {
      success: true,
      claimNumber,
      status: 'received',
      policyNumber,
      insuredName: policy.insuredName,
      coverageTier: estimate.schedule.label,
      vehicle: vehicle.label,
      incidentType: incident.label,
      incidentDate,
      deductibleApplied: roundMoney(estimate.deductible),
      estimatedRepairCost: estimate.repairEstimate.subtotal,
      estimatedPayout: estimate.estimatedPayout,
      adjuster: {
        id: estimate.adjuster.id,
        name: estimate.adjuster.name,
        phone: estimate.adjuster.phone,
      },
      inspectionScheduledFor: inspectionDate.toISOString(),
      submittedAt,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const coverageTierCode = policy && policy.coverageTierCode;

    incrementMetric('qbe_claim.failure', {
      route: '/api/qbe/claim',
      errorClass: error.name,
      incidentType,
      coverageTier: coverageTierCode,
    });
    recordTiming('qbe_claim.latency', duration, {
      route: '/api/qbe/claim',
      error: 'true',
    });

    logger.error('QBE claim submission failed', {
      claimNumber,
      policyNumber,
      incidentType,
      incidentDate,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: 'customer-qbe-claim',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/qbe/claim',
        service: 'customer-qbe-claim',
        coverageTier: coverageTierCode,
      },
      extra: {
        claimNumber,
        policyNumber,
        coverageTierCode,
        incidentType,
        incidentDate,
        photoCount: data.photoCount,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/qbe.js — calculateAdjusterEstimate',
      errorType: error.name || 'Error',
      errorValue: error.message,
      service: 'customer-qbe-claim',
      verticalLabel: 'QBE Claims — File a Claim',
      customer: 'qbe',
      slackMemberId: 'U0BKV8PTK6F',
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: [
        { key: 'route', value: '/api/qbe/claim' },
        { key: 'service', value: 'customer-qbe-claim' },
        { key: 'coverageTier', value: coverageTierCode },
        { key: 'incidentType', value: incidentType },
      ],
      extra: {
        claimNumber,
        policyNumber,
        coverageTierCode,
        incidentType,
        incidentDate,
        photoCount: data.photoCount,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-qbe-claim@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for QBE claim error', {
        claimNumber,
        error: alertError.message,
      });
    });

    throw error;
  }
}

module.exports = {
  submitClaim,
  resolveDeductibleSchedule,
  calculateRepairEstimate,
  assignAdjuster,
  calculateAdjusterEstimate,
  POLICIES,
  DEDUCTIBLE_SCHEDULES,
  INCIDENT_TYPES,
  ADJUSTERS,
  REMEDIATION_DIRECTIVE,
};
