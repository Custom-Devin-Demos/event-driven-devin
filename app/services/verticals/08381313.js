const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const COMPANIES = [
  {
    id: 'KII-9204715',
    name: 'Koch Ag & Energy Solutions',
    sector: 'agriculture',
    region: 'north_america',
    subsidiaries: [
      { id: 'sub-001', name: 'Koch Fertilizer', supplyCategory: 'chemicals' },
      { id: 'sub-002', name: 'Koch Agronomic Services', supplyCategory: 'agronomy' },
    ],
  },
  {
    id: 'KII-3817062',
    name: 'Georgia-Pacific',
    sector: 'consumer_products',
    region: 'global',
    subsidiaries: [
      { id: 'sub-010', name: 'GP Consumer Products', supplyCategory: 'paper_goods' },
      { id: 'sub-011', name: 'GP Building Products', supplyCategory: 'construction' },
    ],
  },
];

const SECTOR_CONFIG = {
  agriculture: { complianceTier: 'standard', reviewCycleDays: 90, hazmatRequired: true },
  consumer_products: { complianceTier: 'enhanced', reviewCycleDays: 60, hazmatRequired: false },
  technology: { complianceTier: 'standard', reviewCycleDays: 120, hazmatRequired: false },
  energy: { complianceTier: 'critical', reviewCycleDays: 30, hazmatRequired: true },
};

const SUPPLY_CHAIN_METRICS = [
  { metricId: 'scm-lead-time', label: 'Average Lead Time', value: 14.2, unit: 'days', target: 12.0 },
  { metricId: 'scm-fill-rate', label: 'Order Fill Rate', value: 96.8, unit: '%', target: 98.0 },
  { metricId: 'scm-on-time', label: 'On-Time Delivery', value: 93.5, unit: '%', target: 95.0 },
  { metricId: 'scm-defect-rate', label: 'Defect Rate', value: 0.4, unit: '%', target: 0.5 },
];

function resolveCompany(companyId) {
  return COMPANIES.find((c) => c.id === companyId) || COMPANIES[0];
}

function getSectorCompliance(company) {
  const config = SECTOR_CONFIG[company.sector];
  const now = Date.now();
  const cycleMs = config.reviewCycleDays * 86400000;
  return {
    complianceTier: config.complianceTier,
    reviewCycleDays: config.reviewCycleDays,
    hazmatRequired: config.hazmatRequired,
    nextReviewDate: new Date(now + cycleMs).toISOString(),
    auditTrail: {
      lastAuditDate: new Date(now - cycleMs).toISOString(),
      nextAuditDate: new Date(now + cycleMs).toISOString(),
    },
  };
}

function aggregateSubsidiaryMetrics(company) {
  return company.subsidiaries.map((sub) => ({
    subsidiaryId: sub.id,
    name: sub.name,
    supplyCategory: sub.supplyCategory,
    metrics: SUPPLY_CHAIN_METRICS.map((m) => ({
      ...m,
      variance: Math.round((m.value - m.target) * 100) / 100,
      status: m.value >= m.target ? 'on_track' : 'below_target',
    })),
  }));
}

function buildComplianceReport(company, compliance, subsidiaryData) {
  const allMetrics = subsidiaryData.flatMap((s) => s.metrics);
  const belowTarget = allMetrics.filter((m) => m.status === 'below_target');

  return {
    companyId: company.id,
    companyName: company.name,
    sector: company.sector,
    region: company.region,
    compliance: {
      tier: compliance.complianceTier,
      nextReview: compliance.nextReviewDate,
      hazmatCertification: compliance.hazmatRequired,
      auditTrail: compliance.auditTrail.lastAuditDate,
    },
    subsidiaries: subsidiaryData,
    summary: {
      totalMetrics: allMetrics.length,
      belowTarget: belowTarget.length,
      overallScore: Math.round((1 - belowTarget.length / allMetrics.length) * 100),
    },
  };
}

async function processSupplyInquiry(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Processing supply chain inquiry', {
    requestId,
    companyId: data.companyId,
    service: 'customer-08381313-supply',
    route: '/api/08381313/supply-inquiry',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const company = resolveCompany(data.companyId);
    const compliance = getSectorCompliance(company);
    const subsidiaryData = aggregateSubsidiaryMetrics(company);
    const report = buildComplianceReport(company, compliance, subsidiaryData);

    report.requestId = requestId;
    report.generatedAt = new Date().toISOString();

    const duration = Date.now() - startTime;

    incrementMetric('supply_inquiry.success', {
      route: '/api/08381313/supply-inquiry',
      sector: company.sector,
    });
    recordTiming('supply_inquiry.latency', duration, {
      route: '/api/08381313/supply-inquiry',
    });

    return report;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('supply_inquiry.failure', {
      route: '/api/08381313/supply-inquiry',
      errorClass: error.name,
    });
    recordTiming('supply_inquiry.latency', duration, {
      route: '/api/08381313/supply-inquiry',
      error: 'true',
    });

    logger.error('Supply chain inquiry failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      companyId: data.companyId,
      service: 'customer-08381313-supply',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/08381313/supply-inquiry',
        service: 'customer-08381313-supply',
        sector: data.sector,
      },
      extra: { requestId, companyId: data.companyId },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/08381313.js \u2014 buildComplianceReport',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-08381313-supply',
      verticalLabel: 'Supply Chain Inquiry',
      customer: '08381313',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/08381313/supply-inquiry' },
        { key: 'service', value: 'customer-08381313-supply' },
        { key: 'sector', value: data.sector },
      ],
      extra: { requestId, companyId: data.companyId },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-08381313-supply@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for supply inquiry error', {
        error: err.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = {
  processSupplyInquiry,
  resolveCompany,
  getSectorCompliance,
  aggregateSubsidiaryMetrics,
  buildComplianceReport,
  COMPANIES,
  SECTOR_CONFIG,
  SUPPLY_CHAIN_METRICS,
};
