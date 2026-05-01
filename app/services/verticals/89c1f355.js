const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const DIVISIONS = [
  { code: 'investment-banking', name: 'Investment Banking', regions: ['NYC', 'LON', 'HKG'], headcount: 4200 },
  { code: 'sales-trading', name: 'Sales & Trading', regions: ['NYC', 'CHI', 'LON'], headcount: 3100 },
  { code: 'asset-management', name: 'Asset Management', regions: ['NYC', 'SFO', 'LON'], headcount: 2800 },
  { code: 'wealth-management', name: 'Wealth Management', regions: ['NYC', 'MIA', 'DAL'], headcount: 5600 },
  { code: 'technology', name: 'Technology', regions: ['NYC', 'BNG', 'DAL'], headcount: 8200 },
  { code: 'operations', name: 'Operations', regions: ['SLC', 'BNG', 'MNL'], headcount: 6400 },
];

const ROLE_CATALOG = [
  { id: 'analyst-ib', title: 'Investment Banking Analyst', level: 'junior', compensation: 110000, division: 'investment-banking' },
  { id: 'associate-ib', title: 'Investment Banking Associate', level: 'mid', compensation: 175000, division: 'investment-banking' },
  { id: 'vp-ib', title: 'Vice President — IBD', level: 'senior', compensation: 280000, division: 'investment-banking' },
  { id: 'quant-st', title: 'Quantitative Trader', level: 'mid', compensation: 200000, division: 'sales-trading' },
  { id: 'analyst-am', title: 'Portfolio Analyst', level: 'junior', compensation: 95000, division: 'asset-management' },
  { id: 'advisor-wm', title: 'Financial Advisor', level: 'mid', compensation: 150000, division: 'wealth-management' },
  { id: 'swe-tech', title: 'Software Engineer', level: 'mid', compensation: 185000, division: 'technology' },
  { id: 'sre-tech', title: 'Site Reliability Engineer', level: 'senior', compensation: 210000, division: 'technology' },
];

const SENIORITY_WEIGHTS = {
  junior: { urgencyMultiplier: 1.0, offerPremium: 0 },
  mid: { urgencyMultiplier: 1.3, offerPremium: 0.08 },
  senior: { urgencyMultiplier: 1.8, offerPremium: 0.15 },
};

const DIVISION_METRICS = {
  'investment-banking': {
    staffing: { totalHeadcount: 4200, openReqs: 84, attritionPct: 12.5 },
    pipeline: { activeCandidates: 320, interviewStage: 95, offersPending: 18 },
    budget: { allocated: 52000000, spent: 41200000, remaining: 10800000 },
  },
  'sales-trading': {
    staffing: { totalHeadcount: 3100, openReqs: 45, attritionPct: 9.2 },
    pipeline: { activeCandidates: 180, interviewStage: 52, offersPending: 11 },
    budget: { allocated: 38000000, spent: 31000000, remaining: 7000000 },
  },
  'asset-management': {
    staffing: { totalHeadcount: 2800, openReqs: 32, attritionPct: 7.8 },
    pipeline: { activeCandidates: 145, interviewStage: 38, offersPending: 8 },
    budget: { allocated: 29000000, spent: 22500000, remaining: 6500000 },
  },
  'wealth-management': {
    staffing: { totalHeadcount: 5600, openReqs: 110, attritionPct: 14.1 },
    pipeline: { activeCandidates: 520, interviewStage: 145, offersPending: 32 },
    budget: { allocated: 71000000, spent: 58000000, remaining: 13000000 },
  },
  'technology': {
    staffing: { totalHeadcount: 8200, openReqs: 195, attritionPct: 16.3 },
    pipeline: { activeCandidates: 840, interviewStage: 210, offersPending: 45 },
    budget: { allocated: 95000000, spent: 72000000, remaining: 23000000 },
  },
  'operations': {
    staffing: { totalHeadcount: 6400, openReqs: 78, attritionPct: 8.5 },
    pipeline: { activeCandidates: 290, interviewStage: 82, offersPending: 15 },
    budget: { allocated: 44000000, spent: 36000000, remaining: 8000000 },
  },
};

function getDivisionMetrics(divisionCode) {
  const metrics = DIVISION_METRICS[divisionCode];
  if (!metrics) return DIVISION_METRICS['investment-banking'];
  return metrics;
}

function computeRecruitmentMetrics(roles, divisionCode) {
  const metrics = getDivisionMetrics(divisionCode);
  return roles.map((role) => {
    const demandScore = role.compensation / metrics.staffing.totalHeadcount;
    const isUrgent = demandScore > 30;
    return {
      roleId: role.id,
      title: role.title,
      level: role.level,
      compensation: role.compensation,
      demandScore: Math.round(demandScore * 10000) / 10000,
      isUrgent,
    };
  });
}

function calculateOfferPackage(role, seniorityConfig, divisionMetrics) {
  const baseSalary = role.compensation;
  const premium = baseSalary * seniorityConfig.offerPremium;
  const totalComp = baseSalary + premium;
  const budgetImpact = totalComp / divisionMetrics.budget.remaining;

  return {
    roleId: role.id,
    title: role.title,
    baseSalary,
    offerPremium: Math.round(premium),
    totalCompensation: Math.round(totalComp),
    budgetImpactPct: Math.round(budgetImpact * 10000) / 100,
    signingBonus: role.level === 'senior' ? Math.round(baseSalary * 0.2) : 0,
  };
}

function buildPipelineSummary(divisionMetrics, recruitmentMetrics) {
  const urgentRoles = recruitmentMetrics.filter((r) => r.isUrgent);
  const avgDemandScore = recruitmentMetrics.length > 0 ? recruitmentMetrics.reduce((sum, r) => sum + r.demandScore, 0) / recruitmentMetrics.length : 0;

  return {
    activeCandidates: divisionMetrics.pipeline.activeCandidates,
    interviewStage: divisionMetrics.pipeline.interviewStage,
    offersPending: divisionMetrics.pipeline.offersPending,
    openReqs: divisionMetrics.staffing.openReqs,
    attritionPct: divisionMetrics.staffing.attritionPct,
    urgentRoles: urgentRoles.length,
    avgDemandScore: Math.round(avgDemandScore * 10000) / 10000,
  };
}

function buildInquiryResponse(division, recruitmentMetrics, pipelineSummary, offerPackages) {
  return {
    division: division.name,
    divisionCode: division.code,
    regions: division.regions,
    headcount: division.headcount,
    pipeline: pipelineSummary,
    roles: recruitmentMetrics,
    offers: offerPackages,
    recommendations: [],
  };
}

async function runInquiry(data) {
  const startTime = Date.now();
  const inquiryId = uuidv4();

  logger.info('Processing recruitment inquiry', {
    inquiryId,
    division: data.division,
    service: 'customer-89c1f355-careers',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 100));

    const division = DIVISIONS.find((d) => d.code === data.division);
    if (!division) {
      const err = new Error(`Unknown division: ${data.division}`);
      err.code = 'INVALID_DIVISION';
      throw err;
    }

    const roles = ROLE_CATALOG.filter((r) => r.division === data.division);
    const divisionMetrics = getDivisionMetrics(data.division);
    const recruitmentMetrics = computeRecruitmentMetrics(roles, data.division);

    const offerPackages = roles.map((role) => {
      const seniorityConfig = SENIORITY_WEIGHTS[role.level];
      return calculateOfferPackage(role, seniorityConfig, divisionMetrics);
    });

    const pipelineSummary = buildPipelineSummary(divisionMetrics, recruitmentMetrics);
    const response = buildInquiryResponse(division, recruitmentMetrics, pipelineSummary, offerPackages);

    response.inquiryId = inquiryId;
    response.completedAt = new Date().toISOString();

    if (pipelineSummary.urgentRoles > 0) {
      response.recommendations.push('Prioritize urgent roles for immediate sourcing');
      response.recommendations.push('Consider retention bonuses for high-attrition divisions');
    }
    if (pipelineSummary.attritionPct > 15) {
      response.recommendations.push('Review compensation benchmarks against market data');
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
      extra: { inquiryId, division: data.division },
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
      tags: [
        { key: 'route', value: '/api/89c1f355/inquiry' },
        { key: 'service', value: 'customer-89c1f355-careers' },
        { key: 'division', value: data.division },
      ],
      extra: { inquiryId, division: data.division },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-89c1f355-careers@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from inquiry error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { runInquiry, DIVISIONS, ROLE_CATALOG };
