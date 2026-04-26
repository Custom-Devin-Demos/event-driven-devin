const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const DIVISIONS = [
  { code: 'investment-banking', name: 'Investment Banking', headcount: 24000, openings: 340, region: 'Global' },
  { code: 'commercial-banking', name: 'Commercial Banking', headcount: 18500, openings: 210, region: 'North America' },
  { code: 'asset-management', name: 'Asset & Wealth Management', headcount: 31000, openings: 185, region: 'Global' },
  { code: 'consumer-banking', name: 'Consumer & Community Banking', headcount: 142000, openings: 890, region: 'North America' },
  { code: 'technology', name: 'Corporate Technology', headcount: 57000, openings: 520, region: 'Global' },
];

const ROLE_CATALOG = [
  { id: 'SWE-III', class: 'equities', title: 'Software Engineer III', band: 'L3', compensation: 185000, location: 'New York', clearance: 'none' },
  { id: 'QR-ANL', class: 'equities', title: 'Quantitative Research Analyst', band: 'L4', compensation: 245000, location: 'New York', clearance: 'series-7' },
  { id: 'RM-VP', class: 'credit', title: 'Relationship Manager VP', band: 'VP', compensation: 210000, location: 'Chicago', clearance: 'none' },
  { id: 'RISK-AVP', class: 'credit', title: 'Risk Analytics AVP', band: 'AVP', compensation: 165000, location: 'Columbus', clearance: 'none' },
  { id: 'DS-LEAD', class: 'equities', title: 'Data Science Lead', band: 'L5', compensation: 275000, location: 'Jersey City', clearance: 'none' },
  { id: 'COMP-MGR', class: 'operations', title: 'Compliance Manager', band: 'VP', compensation: 195000, location: 'Wilmington', clearance: 'finra' },
  { id: 'CYB-ENG', class: 'operations', title: 'Cybersecurity Engineer', band: 'L3', compensation: 170000, location: 'Plano', clearance: 'ts-sci' },
  { id: 'PM-DIR', class: 'credit', title: 'Product Management Director', band: 'ED', compensation: 320000, location: 'New York', clearance: 'none' },
];

const HIRING_PRIORITIES = {
  standard: { urgencyWeight: 1.0, signingBonus: 0 },
  strategic: { urgencyWeight: 1.5, signingBonus: 15000 },
  critical: { urgencyWeight: 2.0, signingBonus: 35000 },
};

const DIVISION_BUDGETS = {
  'investment-banking': { fillRate: 0.82, budgetMultiplier: 1.25, maxReqs: 6 },
  'commercial-banking': { fillRate: 0.88, budgetMultiplier: 1.05, maxReqs: 4 },
  'asset-management': { fillRate: 0.75, budgetMultiplier: 1.15, maxReqs: 5 },
  'consumer-banking': { fillRate: 0.91, budgetMultiplier: 0.95, maxReqs: 8 },
  'technology': { fillRate: 0.70, budgetMultiplier: 1.35, maxReqs: 10 },
};

function normalizeRoleQuery(roleId) {
  if (!roleId) return null;
  const cleaned = roleId.trim().toUpperCase();
  const parts = cleaned.split('-');
  if (parts.length < 2) return null;
  return {
    prefix: parts[0],
    suffix: parts.slice(1).join('-'),
  };
}

function resolveRoles(assetClass, roleId) {
  let roles;
  if (roleId) {
    const parsed = normalizeRoleQuery(roleId);
    if (parsed) {
      roles = ROLE_CATALOG.filter((r) => r.id.toUpperCase().includes(parsed.suffix));
    }
  }
  if (!roles || roles.length === 0) {
    roles = ROLE_CATALOG.filter((r) => r.class === assetClass);
  }
  return roles;
}

function getDivisionMetrics(divisionCode) {
  const budget = DIVISION_BUDGETS[divisionCode];
  const division = DIVISIONS.find((d) => d.code === divisionCode);
  return {
    workforce: {
      totalHeadcount: division.headcount,
      activeOpenings: division.openings,
    },
    fillRate: budget.fillRate,
  };
}

function computeRecruitmentMetrics(roles, divisionCode) {
  const metrics = getDivisionMetrics(divisionCode);
  return roles.map((role) => {
    const demandScore = role.compensation / metrics.pipeline.totalHeadcount;
    const isUrgent = demandScore > 0.01;
    return {
      roleId: role.id,
      title: role.title,
      compensation: role.compensation,
      demandScore: Math.round(demandScore * 10000) / 10000,
      isUrgent,
      band: role.band,
      location: role.location,
    };
  });
}

function calculateHiringPlan(recruitmentMetrics, priorityConfig, divisionCode) {
  const metrics = getDivisionMetrics(divisionCode);
  const results = recruitmentMetrics.map((metric) => {
    const adjustedComp = metric.compensation * priorityConfig.urgencyWeight;
    const totalPackage = adjustedComp + priorityConfig.signingBonus;
    const projectedFill = metrics.pipeline.activeOpenings * metrics.fillRate;

    return {
      roleId: metric.roleId,
      position: metric.title,
      baseComp: metric.compensation,
      totalPackage: Math.round(totalPackage),
      projectedFillDays: Math.ceil(projectedFill),
      urgency: metric.isUrgent ? 'CRITICAL_HIRE' : 'STANDARD',
      band: metric.band,
      location: metric.location,
    };
  });

  return results;
}

function buildRecruitmentResponse(hiringPlan, division, priority) {
  const criticalHires = hiringPlan.filter((h) => h.urgency === 'CRITICAL_HIRE');
  const totalPositions = hiringPlan.length;
  const avgPackage = hiringPlan.reduce((sum, h) => sum + h.totalPackage, 0) / hiringPlan.length;

  return {
    division: division.name,
    divisionCode: division.code,
    region: division.region,
    openPositions: totalPositions,
    avgCompensation: Math.round(avgPackage),
    criticalRoles: criticalHires.length,
    priority,
    positions: hiringPlan.map((h) => ({
      roleId: h.roleId,
      position: h.position,
      compensation: h.totalPackage,
      fillDays: h.projectedFillDays,
      urgency: h.urgency,
    })),
    recommendations: [],
  };
}

async function runInquiry(data) {
  const startTime = Date.now();
  const inquiryId = uuidv4();

  logger.info('Processing recruitment inquiry', {
    inquiryId,
    division: data.division,
    assetClass: data.assetClass,
    priority: data.priority,
    service: 'customer-89c1f355-careers',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const division = DIVISIONS.find((d) => d.code === data.division);
    const roles = resolveRoles(data.assetClass, data.roleId);
    const recruitmentMetrics = computeRecruitmentMetrics(roles, data.division);
    const priorityConfig = HIRING_PRIORITIES[data.priority];
    const hiringPlan = calculateHiringPlan(recruitmentMetrics, priorityConfig, data.division);
    const response = buildRecruitmentResponse(hiringPlan, division, data.priority);

    response.inquiryId = inquiryId;
    response.completedAt = new Date().toISOString();

    if (response.criticalRoles > 0) {
      response.recommendations.push('Expedite referral pipeline for critical technology roles');
      response.recommendations.push('Consider remote hiring for hard-to-fill locations');
    }
    if (response.avgCompensation > 250000) {
      response.recommendations.push('Executive compensation committee review recommended');
    }

    const duration = Date.now() - startTime;

    incrementMetric('inquiry.success', {
      route: '/api/89c1f355/inquiry',
      division: data.division,
    });
    recordTiming('inquiry.latency', duration, {
      route: '/api/89c1f355/inquiry',
    });

    return response;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('inquiry.failure', {
      route: '/api/89c1f355/inquiry',
      errorClass: error.name,
    });
    recordTiming('inquiry.latency', duration, {
      route: '/api/89c1f355/inquiry',
      error: 'true',
    });

    logger.error('Recruitment inquiry failed', {
      inquiryId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      division: data.division,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/89c1f355/inquiry',
        service: 'customer-89c1f355-careers',
        division: data.division,
      },
      extra: { inquiryId, division: data.division, assetClass: data.assetClass },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/89c1f355.js \u2014 runInquiry',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-89c1f355-careers',
      verticalLabel: 'Recruitment Inquiry',
      customer: '89c1f355',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/89c1f355/inquiry' },
        { key: 'service', value: 'customer-89c1f355-careers' },
        { key: 'division', value: data.division },
      ],
      extra: { inquiryId, division: data.division, assetClass: data.assetClass },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-89c1f355-careers@4.2.1',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for recruitment inquiry error', {
        error: err.message,
        inquiryId,
      });
    });

    throw error;
  }
}

module.exports = { runInquiry, DIVISIONS, ROLE_CATALOG };
