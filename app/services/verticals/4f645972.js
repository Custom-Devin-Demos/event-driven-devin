const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Coverage tiers available on an auto policy. Each tier defines the
 * per-incident deductibles the policyholder is responsible for, plus
 * the daily rental-reimbursement allowance while a vehicle is in the shop.
 *
 * Liability-only tiers do not carry physical-damage deductibles because
 * they do not cover repairs to the insured's own vehicle.
 */
const COVERAGE_TIERS = {
  full: {
    code: 'FULL',
    label: 'Full Coverage',
    deductibles: { collision: 500, comprehensive: 250, glass: 0 },
    rentalPerDay: 40,
  },
  standard: {
    code: 'STD',
    label: 'Standard Coverage',
    deductibles: { collision: 1000, comprehensive: 500, glass: 100 },
    rentalPerDay: 25,
  },
  liability: {
    code: 'LIAB',
    label: 'Liability Only',
    rentalPerDay: 0,
  },
};

/**
 * Vehicles on the policyholder's account, each mapped to a coverage tier.
 */
const VEHICLES = [
  { id: 'veh-1', label: '2022 Honda CR-V EX', vin: '2HKRW2HondaCRV0001', plate: 'PGR-4821', coverageTier: 'liability' },
  { id: 'veh-2', label: '2019 Toyota Camry SE', vin: '4T1B11HKToyCam0002', plate: 'PGR-1907', coverageTier: 'full' },
  { id: 'veh-3', label: '2023 Ford F-150 XLT', vin: '1FTFW1EFordF150003', plate: 'PGR-3355', coverageTier: 'standard' },
];

/**
 * Incident (loss) types a policyholder can file a claim against, with the
 * base estimated repair cost the shop network reports for that loss type.
 */
const INCIDENT_TYPES = [
  { id: 'collision', label: 'Collision', baseRepair: 4200 },
  { id: 'comprehensive', label: 'Comprehensive (theft / weather)', baseRepair: 2600 },
  { id: 'glass', label: 'Glass Only', baseRepair: 650 },
];

function findVehicle(vehicleId) {
  return VEHICLES.find((v) => v.id === vehicleId) || VEHICLES[0];
}

function findIncidentType(incidentTypeId) {
  return INCIDENT_TYPES.find((t) => t.id === incidentTypeId) || INCIDENT_TYPES[0];
}

/**
 * Resolve the coverage tier that applies to the vehicle on the claim.
 */
function resolveCoverage(vehicle) {
  return COVERAGE_TIERS[vehicle.coverageTier] || COVERAGE_TIERS.standard;
}

/**
 * Determine the out-of-pocket deductible that applies to this loss type
 * under the vehicle's coverage tier.
 */
function calculateDeductible(coverage, incidentType) {
  const applicable = coverage.deductibles[incidentType.id];
  return applicable != null ? applicable : coverage.deductibles.collision;
}

/**
 * Apply the field adjuster's severity factor to the shop's base repair cost.
 */
function applyAdjusterFactor(baseRepair, severity) {
  const factor = severity === 'major' ? 1.4 : severity === 'moderate' ? 1.15 : 1.0;
  return Math.round(baseRepair * factor * 100) / 100;
}

/**
 * Assemble the final repair estimate shown to the policyholder, netting
 * out the applicable deductible and adding rental reimbursement.
 */
function assembleEstimate(vehicle, coverage, incidentType, repairCost, deductible, rentalDays) {
  const rentalReimbursement = coverage.rentalPerDay * rentalDays;
  const estimatedPayout = Math.max(0, repairCost - deductible);

  return {
    vehicle: vehicle.label,
    plate: vehicle.plate,
    coverage: coverage.label,
    incidentType: incidentType.label,
    repairCost,
    deductible,
    rentalDays,
    rentalReimbursement,
    estimatedPayout: Math.round(estimatedPayout * 100) / 100,
  };
}

/**
 * Process a "File a Claim" / repair-estimate request from the claims portal.
 */
async function processClaimEstimate(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Processing claim repair estimate', {
    requestId,
    vehicleId: data.vehicleId,
    incidentType: data.incidentType,
    service: 'customer-4f645972-claims',
    route: '/api/4f645972/estimate',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 110));

    const vehicle = findVehicle(data.vehicleId);
    const incidentType = findIncidentType(data.incidentType);
    const coverage = resolveCoverage(vehicle);

    const repairCost = applyAdjusterFactor(incidentType.baseRepair, data.severity);
    const deductible = calculateDeductible(coverage, incidentType);
    const estimate = assembleEstimate(
      vehicle,
      coverage,
      incidentType,
      repairCost,
      deductible,
      data.rentalDays || 0,
    );

    estimate.requestId = requestId;
    estimate.claimNumber = `CLM-${Date.now().toString().slice(-8)}`;
    estimate.filedAt = new Date().toISOString();

    const duration = Date.now() - startTime;

    incrementMetric('claim_estimate.success', {
      route: '/api/4f645972/estimate',
      incidentType: data.incidentType,
    });
    recordTiming('claim_estimate.latency', duration, {
      route: '/api/4f645972/estimate',
    });

    return estimate;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('claim_estimate.failure', {
      route: '/api/4f645972/estimate',
      errorClass: error.name,
    });
    recordTiming('claim_estimate.latency', duration, {
      route: '/api/4f645972/estimate',
      error: 'true',
    });

    logger.error('Claim repair estimate failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      vehicleId: data.vehicleId,
      incidentType: data.incidentType,
      service: 'customer-4f645972-claims',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/4f645972/estimate',
        service: 'customer-4f645972-claims',
        customer: 'claims-portal',
        tenant: 'claims',
        scenario: 'claim-estimate',
        incidentType: data.incidentType,
      },
      extra: { requestId, vehicleId: data.vehicleId, incidentType: data.incidentType },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/4f645972.js \u2014 calculateDeductible',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-4f645972-claims',
      verticalLabel: 'Claims Estimate',
      customer: '4f645972',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/4f645972/estimate' },
        { key: 'service', value: 'customer-4f645972-claims' },
        { key: 'incidentType', value: data.incidentType },
      ],
      extra: { requestId, vehicleId: data.vehicleId, incidentType: data.incidentType },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'claims-portal',
      release: 'claims-portal@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for claim estimate error', {
        error: err.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = { processClaimEstimate, COVERAGE_TIERS, VEHICLES, INCIDENT_TYPES };
