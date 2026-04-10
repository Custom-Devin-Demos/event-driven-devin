const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const PORTFOLIO_DATA = {
  'app-software': [
    { id: 'RT-001', name: 'Vertafore', revenueMM: 680, growthPct: 14.2, marginPct: 42.1 },
    { id: 'RT-002', name: 'Deltek', revenueMM: 520, growthPct: 11.8, marginPct: 38.7 },
    { id: 'RT-003', name: 'Aderant', revenueMM: 310, growthPct: 9.5, marginPct: 35.4 },
    { id: 'RT-004', name: 'Strata Decision', revenueMM: 245, growthPct: 16.3, marginPct: 44.0 },
    { id: 'RT-005', name: 'Data Innovations', revenueMM: 190, growthPct: 7.8, marginPct: 31.2 },
  ],
  'network-software': [
    { id: 'RT-010', name: 'iPipeline', revenueMM: 410, growthPct: 10.1, marginPct: 36.5 },
    { id: 'RT-011', name: 'ConstructConnect', revenueMM: 335, growthPct: 8.4, marginPct: 33.8 },
    { id: 'RT-012', name: 'Foundry', revenueMM: 280, growthPct: 12.6, marginPct: 39.2 },
  ],
  'tech-products': [
    { id: 'RT-020', name: 'Neptune Technology', revenueMM: 620, growthPct: 5.9, marginPct: 26.3 },
    { id: 'RT-021', name: 'Verathon', revenueMM: 480, growthPct: 8.2, marginPct: 30.1 },
    { id: 'RT-022', name: 'Northern Digital', revenueMM: 215, growthPct: 6.7, marginPct: 28.8 },
    { id: 'RT-023', name: 'CIVCO Medical', revenueMM: 175, growthPct: 4.3, marginPct: 24.5 },
  ],
};

const SEGMENT_WEIGHTS = {
  revenue: { 'app-software': 0.40, 'network-software': 0.35, 'tech-products': 0.25 },
  growth: { 'app-software': 0.45, 'network-software': 0.30, 'tech-products': 0.25 },
  margin: { 'app-software': 0.38, 'network-software': 0.32, 'tech-products': 0.30 },
};

const QUARTER_FACTORS = {
  Q1: 0.92, Q2: 1.05, Q3: 1.08, Q4: 0.95,
};

const BENCHMARK_TARGETS = {
  'app-software': { revenue: 2100, growth: 12.0, margin: 38.0 },
  'network-software': { revenue: 1200, growth: 10.0, margin: 35.0 },
  'tech-products': { revenue: 1600, growth: 7.0, margin: 27.0 },
};

function resolveSegmentKey(displayName) {
  const mapping = {
    'Application Software': 'application_software',
    'Network Software': 'network_software',
    'Technology Enabled Products': 'tech_products',
  };
  return mapping[displayName] || displayName.toLowerCase().replace(/\s+/g, '_');
}

function getPortfolioCompanies(segmentKey) {
  const companies = PORTFOLIO_DATA[segmentKey];
  return companies;
}

function applyCompanyFilter(companies, filterStr) {
  if (!filterStr) return companies;
  const terms = filterStr.split(',').map((t) => t.trim().toLowerCase());
  return companies.filter((c) => terms.some((t) => c.name.toLowerCase().includes(t)));
}

function computeQuarterlyMetrics(companies, quarter, metricFocus) {
  const factor = QUARTER_FACTORS[quarter];

  const transformed = companies.map((c) => ({
    companyId: c.id,
    companyName: c.name,
    metrics: {
      revenue: c.revenueMM * factor,
      growth: c.growthPct * factor,
      margin: c.marginPct,
    },
  }));

  const totals = transformed.reduce(
    (acc, entry) => {
      acc.totalRevenue += entry.metrics.revenue;
      acc.totalGrowth += entry.metrics.growth;
      acc.totalMargin += entry.metrics.margin;
      return acc;
    },
    { totalRevenue: 0, totalGrowth: 0, totalMargin: 0 },
  );

  const count = transformed.length;

  return {
    companies: transformed,
    aggregated: {
      revenue: totals.totalRevenue,
      avgGrowth: totals.totalGrowth / count,
      avgMargin: totals.totalMargin / count,
    },
    focus: metricFocus,
    count,
  };
}

function calculatePerformanceIndex(metrics, segmentKey, metricFocus) {
  const weights = SEGMENT_WEIGHTS[metricFocus];
  const segmentWeight = weights[segmentKey];
  const benchmark = BENCHMARK_TARGETS[segmentKey];

  const revenueRatio = metrics.aggregated.revenue / benchmark.revenue;
  const growthDelta = metrics.aggregated.avgGrowth - benchmark.growth;
  const marginDelta = metrics.aggregated.avgMargin - benchmark.margin;

  const rawIndex = (revenueRatio * 40) + (growthDelta * 3) + (marginDelta * 2);
  const weightedIndex = rawIndex * segmentWeight;

  return {
    rawIndex: rawIndex.toFixed(2),
    weightedIndex: weightedIndex.toFixed(2),
    revenueVsBenchmark: (revenueRatio * 100).toFixed(1),
    growthDelta: growthDelta.toFixed(1),
    marginDelta: marginDelta.toFixed(1),
  };
}

function buildAnalysisReport(segment, metrics, perfIndex, quarter) {
  const rating = parseFloat(perfIndex.weightedIndex) > 15
    ? 'Outperform'
    : parseFloat(perfIndex.weightedIndex) > 8
      ? 'Market Perform'
      : 'Underperform';

  return {
    segment,
    quarter,
    companiesAnalyzed: metrics.count,
    totalRevenueMM: metrics.aggregated.revenue.toFixed(1),
    avgGrowthPct: metrics.aggregated.avgGrowth.toFixed(1),
    avgMarginPct: metrics.aggregated.avgMargin.toFixed(1),
    performanceIndex: perfIndex.weightedIndex,
    rawIndex: perfIndex.rawIndex,
    revenueVsBenchmark: `${perfIndex.revenueVsBenchmark}%`,
    rating,
    topCompanies: metrics.companies
      .sort((a, b) => b.metrics[metrics.focus] - a.metrics[metrics.focus])
      .slice(0, 3)
      .map((c) => ({ name: c.companyName, value: c.metrics[metrics.focus]?.toFixed(1) })),
  };
}

async function analyzePortfolio(data) {
  const startTime = Date.now();
  const analysisId = uuidv4();

  logger.info('Running portfolio segment analysis', {
    analysisId,
    segment: data.segment,
    quarter: data.quarter,
    metricFocus: data.metricFocus,
    service: 'roper-portfolio-analytics',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const segmentKey = resolveSegmentKey(data.segment);
    const companies = getPortfolioCompanies(segmentKey);
    const filtered = applyCompanyFilter(companies, data.companyFilter);
    const metrics = computeQuarterlyMetrics(filtered, data.quarter, data.metricFocus);
    const perfIndex = calculatePerformanceIndex(metrics, segmentKey, data.metricFocus);
    const report = buildAnalysisReport(data.segment, metrics, perfIndex, data.quarter);

    report.analysisId = analysisId;
    report.completedAt = new Date().toISOString();

    const duration = Date.now() - startTime;

    incrementMetric('portfolio.analysis.success', {
      route: '/api/f3ff1d33/analyze',
      segment: data.segment,
    });
    recordTiming('portfolio.analysis.latency', duration, {
      route: '/api/f3ff1d33/analyze',
    });

    return report;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('portfolio.analysis.failure', {
      route: '/api/f3ff1d33/analyze',
      errorClass: error.name,
    });
    recordTiming('portfolio.analysis.latency', duration, {
      route: '/api/f3ff1d33/analyze',
      error: 'true',
    });

    logger.error('Portfolio analysis failed', {
      analysisId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      segment: data.segment,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/f3ff1d33/analyze',
        service: 'roper-portfolio-analytics',
        segment: data.segment,
      },
      extra: {
        analysisId,
        segment: data.segment,
        quarter: data.quarter,
        metricFocus: data.metricFocus,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/f3ff1d33.js \u2014 analyzePortfolio',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'roper-portfolio-analytics',
      verticalLabel: 'Portfolio Analytics',
      customer: 'f3ff1d33',
      tags: [
        { key: 'route', value: '/api/f3ff1d33/analyze' },
        { key: 'service', value: 'roper-portfolio-analytics' },
        { key: 'segment', value: data.segment },
      ],
      extra: { analysisId, segment: data.segment, quarter: data.quarter, metricFocus: data.metricFocus },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'roper-portfolio@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from portfolio analysis error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { analyzePortfolio, PORTFOLIO_DATA, SEGMENT_WEIGHTS };
