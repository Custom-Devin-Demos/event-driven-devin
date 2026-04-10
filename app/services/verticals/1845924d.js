const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const REGIONS = [
  { code: 'NOVA', name: 'Northern Virginia', substations: 87, peakCapacityGW: 5.0, currentLoadGW: 4.2 },
  { code: 'RVA', name: 'Richmond Metro', substations: 64, peakCapacityGW: 4.5, currentLoadGW: 3.1 },
  { code: 'HR', name: 'Hampton Roads', substations: 52, peakCapacityGW: 3.8, currentLoadGW: 2.8 },
  { code: 'SV', name: 'Shenandoah Valley', substations: 38, peakCapacityGW: 2.0, currentLoadGW: 1.4 },
  { code: 'SS', name: 'Southside', substations: 29, peakCapacityGW: 2.2, currentLoadGW: 1.9 },
];

const SUBSTATIONS = [
  { id: 'SUB-2201', region: 'NOVA', circuit: 'Henrico 230kV', loadMW: 142.6, voltagekV: 232.1, status: 'online' },
  { id: 'SUB-2202', region: 'RVA', circuit: 'Chesterfield 115kV', loadMW: 89.3, voltagekV: 114.8, status: 'online' },
  { id: 'SUB-2203', region: 'RVA', circuit: 'James River 500kV', loadMW: 387.1, voltagekV: 498.2, status: 'alarm' },
  { id: 'SUB-2204', region: 'HR', circuit: 'Norfolk Dist 34.5kV', loadMW: 28.4, voltagekV: 34.1, status: 'online' },
  { id: 'SUB-2205', region: 'HR', circuit: 'Virginia Beach 115kV', loadMW: 94.7, voltagekV: 115.1, status: 'online' },
  { id: 'SUB-2206', region: 'NOVA', circuit: 'Loudoun 230kV', loadMW: 201.3, voltagekV: 229.8, status: 'online' },
];

const INCIDENT_REGISTRY = {
  'INC-40821': { severity: 'P1', type: 'transformer_fault', substationId: 'SUB-2203', crewsAssigned: 3 },
  'INC-40819': { severity: 'P2', type: 'vegetation_contact', substationId: 'SUB-2202', crewsAssigned: 1 },
  'INC-40817': { severity: 'P3', type: 'recloser_lockout', substationId: 'SUB-2204', crewsAssigned: 1 },
};

const RISK_THRESHOLDS = {
  reliability: { low: 0.85, medium: 0.70, high: 0.50 },
  capacity: { low: 0.75, medium: 0.60, high: 0.40 },
  restoration: { low: 0.90, medium: 0.80, high: 0.65 },
};

function normalizeIncidentRef(ref) {
  const cleaned = ref.trim().toUpperCase();
  const parts = cleaned.split('-');
  return `${parts[0]}-${parts.slice(1).join('')}`;
}

function lookupIncidentContext(incidentRef) {
  const normalized = normalizeIncidentRef(incidentRef);
  const incident = INCIDENT_REGISTRY[normalized];
  if (!incident) {
    return { found: false, ref: normalized, context: null };
  }
  const substation = SUBSTATIONS.find((s) => s.id === incident.substationId);
  return {
    found: true,
    ref: normalized,
    context: {
      severity: incident.severity,
      type: incident.type,
      substation: substation ? substation.circuit : 'Unknown',
      crewsAssigned: incident.crewsAssigned,
    },
  };
}

function getRegionSubstations(regionCode) {
  return SUBSTATIONS.filter((s) => s.region === regionCode);
}

function computeLoadFactor(substations) {
  const readings = substations.map((sub) => ({
    id: sub.id,
    loadRatio: sub.loadMW / sub.voltagekV,
    status: sub.status,
  }));
  return readings;
}

function calculateReliabilityMetrics(regionData, loadReadings, assessType) {
  const thresholds = RISK_THRESHOLDS[assessType];
  const alarmCount = loadReadings.filter((r) => r.status === 'alarm').length;
  const avgLoadRatio = loadReadings.reduce((sum, r) => sum + r.loadRatio, 0) / loadReadings.length;

  const utilizationPct = regionData.currentLoadGW / regionData.peakCapacityGW;
  const headroom = 1.0 - utilizationPct;
  const baseScore = headroom * 100;

  const penaltyPerAlarm = 12;
  const adjustedScore = Math.max(0, baseScore - (alarmCount * penaltyPerAlarm) - (avgLoadRatio * 2));

  let riskLevel;
  const normalizedScore = adjustedScore / 100;
  if (normalizedScore >= thresholds.low) {
    riskLevel = 'LOW';
  } else if (normalizedScore >= thresholds.medium) {
    riskLevel = 'MODERATE';
  } else if (normalizedScore >= thresholds.high) {
    riskLevel = 'ELEVATED';
  } else {
    riskLevel = 'CRITICAL';
  }

  return {
    score: adjustedScore.toFixed(1),
    riskLevel,
    utilizationPct: (utilizationPct * 100).toFixed(1),
    headroomGW: (regionData.peakCapacityGW - regionData.currentLoadGW).toFixed(2),
    alarmCount,
    substationCount: loadReadings.length,
  };
}

function buildAssessmentReport(region, metrics, priority, incidentContext) {
  const priorityMultipliers = {
    standard: 1.0,
    expedited: 1.5,
    emergency: 2.0,
  };

  const escalationThreshold = priority === 'emergency' ? 'MODERATE' : 'CRITICAL';
  const shouldEscalate = metrics.riskLevel === escalationThreshold
    || metrics.riskLevel === 'CRITICAL';

  const report = {
    region: region.name,
    regionCode: region.code,
    reliabilityScore: parseFloat(metrics.score),
    riskLevel: metrics.riskLevel,
    utilizationPct: parseFloat(metrics.utilizationPct),
    headroomGW: parseFloat(metrics.headroomGW),
    substationsAssessed: metrics.substationCount,
    alarmsDetected: metrics.alarmCount,
    priority,
    escalated: shouldEscalate,
    estimatedCrewsNeeded: Math.ceil(metrics.alarmCount * priorityMultipliers[priority]),
    recommendations: [],
  };

  if (incidentContext && incidentContext.found) {
    report.linkedIncident = incidentContext.context;
  }

  if (metrics.riskLevel === 'CRITICAL' || metrics.riskLevel === 'ELEVATED') {
    report.recommendations.push('Initiate load shedding protocol for non-essential feeders');
    report.recommendations.push('Deploy mobile substations to affected areas');
  }
  if (parseFloat(metrics.utilizationPct) > 80) {
    report.recommendations.push('Activate demand response program for large commercial customers');
  }
  if (metrics.alarmCount > 0) {
    report.recommendations.push(`Dispatch crews to ${metrics.alarmCount} substation(s) reporting alarms`);
  }

  return report;
}

async function runAssessment(data) {
  const startTime = Date.now();
  const assessmentId = uuidv4();

  logger.info('Running grid reliability assessment', {
    assessmentId,
    region: data.region,
    assessType: data.assessType,
    priority: data.priority,
    service: 'dominion-grid-ops',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 150));

    const incidentContext = lookupIncidentContext(data.incidentRef);

    const region = REGIONS.find((r) => r.code === data.region);
    const substations = getRegionSubstations(data.region);
    const loadReadings = computeLoadFactor(substations);
    const metrics = calculateReliabilityMetrics(region, loadReadings, data.assessType);
    const report = buildAssessmentReport(region, metrics, data.priority, incidentContext);

    report.assessmentId = assessmentId;
    report.incidentRef = data.incidentRef || null;
    report.completedAt = new Date().toISOString();

    const duration = Date.now() - startTime;

    incrementMetric('assessment.success', {
      route: '/api/1845924d/assess',
      region: data.region,
    });
    recordTiming('assessment.latency', duration, {
      route: '/api/1845924d/assess',
    });

    return report;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('assessment.failure', {
      route: '/api/1845924d/assess',
      errorClass: error.name,
    });
    recordTiming('assessment.latency', duration, {
      route: '/api/1845924d/assess',
      error: 'true',
    });

    logger.error('Grid reliability assessment failed', {
      assessmentId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      region: data.region,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/1845924d/assess',
        service: 'dominion-grid-ops',
        region: data.region,
      },
      extra: { assessmentId, region: data.region, assessType: data.assessType },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/1845924d.js — runAssessment',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'dominion-grid-ops',
      verticalLabel: 'Grid Reliability Assessment',
      tags: [
        { key: 'route', value: '/api/1845924d/assess' },
        { key: 'service', value: 'dominion-grid-ops' },
      ],
      extra: { assessmentId, region: data.region, assessType: data.assessType },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'dominion-grid-ops@2.1.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from assessment error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { runAssessment, REGIONS, SUBSTATIONS };
