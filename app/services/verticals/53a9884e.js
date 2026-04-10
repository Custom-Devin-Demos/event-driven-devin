const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const FUND_STRATEGIES = {
  'venture-growth': {
    label: 'Venture & Growth Equity',
    benchmarkIRR: 22.5,
    targetMOIC: 3.2,
    sectors: ['technology', 'healthcare', 'consumer', 'fintech'],
  },
  'private-credit': {
    label: 'Private Credit',
    benchmarkIRR: 11.8,
    targetMOIC: 1.4,
    sectors: ['direct-lending', 'mezzanine', 'distressed', 'specialty-finance'],
  },
  'public-equities': {
    label: 'Public Equities',
    benchmarkIRR: 15.3,
    targetMOIC: 2.1,
    sectors: ['long-short', 'event-driven', 'special-situations', 'activist'],
  },
  'multi-strategy': {
    label: 'Multi-Strategy',
    benchmarkIRR: 18.0,
    targetMOIC: 2.6,
    sectors: ['cross-capital', 'hybrid', 'opportunistic', 'co-invest'],
  },
};

const VINTAGE_PERFORMANCE = {
  2024: { deployedPct: 0.35, dpiMultiple: 0.08, tvpiMultiple: 1.12, calledPct: 0.42 },
  2023: { deployedPct: 0.72, dpiMultiple: 0.22, tvpiMultiple: 1.38, calledPct: 0.78 },
  2022: { deployedPct: 0.91, dpiMultiple: 0.45, tvpiMultiple: 1.65, calledPct: 0.95 },
  2021: { deployedPct: 1.0, dpiMultiple: 0.88, tvpiMultiple: 2.14, calledPct: 1.0 },
  2020: { deployedPct: 1.0, dpiMultiple: 1.35, tvpiMultiple: 2.82, calledPct: 1.0 },
};

const RISK_MATRIX = {
  performance: {
    factors: ['returnDispersion', 'benchmarkDeviation', 'jCurvePosition'],
    thresholds: { low: 0.75, moderate: 0.50, elevated: 0.30 },
  },
  risk: {
    factors: ['concentrationRisk', 'currencyExposure', 'liquidityRisk'],
    thresholds: { low: 0.80, moderate: 0.55, elevated: 0.35 },
  },
  exposure: {
    factors: ['sectorConcentration', 'geographicSpread', 'vintageDistribution'],
    thresholds: { low: 0.70, moderate: 0.45, elevated: 0.25 },
  },
};

const INVESTOR_REGISTRY = {
  'INV-100201': { name: 'Pacific Rim Endowment', tier: 'institutional', commitment: 250000000 },
  'INV-100315': { name: 'Nordic Sovereign Fund', tier: 'sovereign', commitment: 500000000 },
  'INV-100422': { name: 'Meridian Family Office', tier: 'family-office', commitment: 75000000 },
};

function resolveInvestorContext(investorId) {
  if (!investorId) {
    return { found: false, id: null, context: null };
  }
  const cleaned = investorId.trim().toUpperCase();
  const investor = INVESTOR_REGISTRY[cleaned];
  if (!investor) {
    return { found: false, id: cleaned, context: null };
  }
  return {
    found: true,
    id: cleaned,
    context: {
      name: investor.name,
      tier: investor.tier,
      commitment: investor.commitment,
    },
  };
}

function loadFundConfiguration(strategyId) {
  const strategy = FUND_STRATEGIES[strategyId];
  if (!strategy) {
    throw new Error(`Unknown fund strategy: ${strategyId}`);
  }
  return {
    portfolio: {
      sectors: strategy.sectors,
      benchmark: strategy.benchmarkIRR,
      targetReturn: strategy.targetMOIC,
    },
    metadata: {
      strategyLabel: strategy.label,
      lastRebalanced: '2026-03-15',
    },
  };
}

function extractPortfolioMetrics(fundConfig) {
  const metrics = fundConfig.analytics;
  return {
    sectors: metrics.sectors,
    benchmark: metrics.benchmark,
    targetReturn: metrics.targetReturn,
  };
}

function computeVintageReturns(vintage, portfolioMetrics) {
  const vintageData = VINTAGE_PERFORMANCE[vintage];
  if (!vintageData) {
    throw new Error(`No performance data for vintage ${vintage}`);
  }

  const rawIRR = portfolioMetrics.benchmark * vintageData.tvpiMultiple;
  const adjustedIRR = rawIRR * (0.85 + Math.random() * 0.3);
  const moic = vintageData.tvpiMultiple * portfolioMetrics.targetReturn;

  return {
    irr: parseFloat(adjustedIRR.toFixed(1)),
    moic: parseFloat(moic.toFixed(2)),
    dpi: vintageData.dpiMultiple,
    tvpi: vintageData.tvpiMultiple,
    deployedPct: vintageData.deployedPct,
    calledPct: vintageData.calledPct,
  };
}

function assessRiskProfile(analysisType, vintageReturns, portfolioMetrics) {
  const riskConfig = RISK_MATRIX[analysisType];
  if (!riskConfig) {
    throw new Error(`Unknown analysis type: ${analysisType}`);
  }

  const sectorDiversity = portfolioMetrics.sectors.length / 6;
  const returnStability = Math.min(1, vintageReturns.irr / (portfolioMetrics.benchmark * 2));
  const deploymentProgress = vintageReturns.deployedPct;

  const compositeScore = (sectorDiversity * 0.3) + (returnStability * 0.4) + (deploymentProgress * 0.3);

  let riskLevel;
  if (compositeScore >= riskConfig.thresholds.low) {
    riskLevel = 'LOW';
  } else if (compositeScore >= riskConfig.thresholds.moderate) {
    riskLevel = 'MODERATE';
  } else if (compositeScore >= riskConfig.thresholds.elevated) {
    riskLevel = 'ELEVATED';
  } else {
    riskLevel = 'HIGH';
  }

  return {
    compositeScore: parseFloat((compositeScore * 100).toFixed(1)),
    riskLevel,
    factors: riskConfig.factors,
    sectorDiversity: parseFloat((sectorDiversity * 100).toFixed(1)),
    returnStability: parseFloat((returnStability * 100).toFixed(1)),
  };
}

function buildAnalysisReport(fundConfig, vintageReturns, riskProfile, investorContext) {
  const report = {
    fund: fundConfig.metadata.strategyLabel,
    irr: vintageReturns.irr,
    moic: vintageReturns.moic,
    dpi: vintageReturns.dpi,
    tvpi: vintageReturns.tvpi,
    riskLevel: riskProfile.riskLevel,
    compositeScore: riskProfile.compositeScore,
    sectorDiversity: riskProfile.sectorDiversity,
    deployedPct: parseFloat((vintageReturns.deployedPct * 100).toFixed(1)),
    calledPct: parseFloat((vintageReturns.calledPct * 100).toFixed(1)),
    recommendations: [],
  };

  if (investorContext && investorContext.found) {
    report.investor = investorContext.context;
  }

  if (riskProfile.riskLevel === 'HIGH' || riskProfile.riskLevel === 'ELEVATED') {
    report.recommendations.push('Consider rebalancing sector allocation to reduce concentration risk');
    report.recommendations.push('Review currency hedging strategy for international holdings');
  }
  if (vintageReturns.irr < fundConfig.portfolio.benchmark) {
    report.recommendations.push('Fund underperforming benchmark — schedule GP review meeting');
  }
  if (vintageReturns.deployedPct < 0.5) {
    report.recommendations.push('Early vintage — monitor deployment pace against investment period');
  }

  return report;
}

async function runPortfolioAnalysis(data) {
  const startTime = Date.now();
  const analysisId = uuidv4();

  logger.info('Running portfolio analysis', {
    analysisId,
    fundStrategy: data.fundStrategy,
    vintageYear: data.vintageYear,
    analysisType: data.analysisType,
    service: 'customer-53a9884e-portfolio',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 150));

    const investorContext = resolveInvestorContext(data.investorId);
    const fundConfig = loadFundConfiguration(data.fundStrategy);
    const portfolioMetrics = extractPortfolioMetrics(fundConfig);
    const vintageReturns = computeVintageReturns(parseInt(data.vintageYear, 10), portfolioMetrics);
    const riskProfile = assessRiskProfile(data.analysisType, vintageReturns, portfolioMetrics);
    const report = buildAnalysisReport(fundConfig, vintageReturns, riskProfile, investorContext);

    report.analysisId = analysisId;
    report.investorId = data.investorId || null;
    report.completedAt = new Date().toISOString();

    const duration = Date.now() - startTime;

    incrementMetric('portfolio_analysis.success', {
      route: '/api/53a9884e/analyze',
      strategy: data.fundStrategy,
    });
    recordTiming('portfolio_analysis.latency', duration, {
      route: '/api/53a9884e/analyze',
    });

    return report;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('portfolio_analysis.failure', {
      route: '/api/53a9884e/analyze',
      errorClass: error.name,
    });
    recordTiming('portfolio_analysis.latency', duration, {
      route: '/api/53a9884e/analyze',
      error: 'true',
    });

    logger.error('Portfolio analysis failed', {
      analysisId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      fundStrategy: data.fundStrategy,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/53a9884e/analyze',
        service: 'customer-53a9884e-portfolio',
        strategy: data.fundStrategy,
      },
      extra: { analysisId, fundStrategy: data.fundStrategy, vintageYear: data.vintageYear },
    });

    createSessionAndAlert({
      customer: '53a9884e',
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/53a9884e.js \u2014 runPortfolioAnalysis',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-53a9884e-portfolio',
      verticalLabel: 'Portfolio Analysis Error',
      tags: [
        { key: 'route', value: '/api/53a9884e/analyze' },
        { key: 'service', value: 'customer-53a9884e-portfolio' },
      ],
      extra: { analysisId, fundStrategy: data.fundStrategy, vintageYear: data.vintageYear },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-53a9884e-portfolio@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from analysis error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { runPortfolioAnalysis, FUND_STRATEGIES, VINTAGE_PERFORMANCE };
