const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/ff27e25f/allocations';
const SERVICE = 'millennium-capital-allocation';

/**
 * Investment teams (pods) on the platform that can request capital.
 */
const PODS = {
  'mlp-pod-4127': {
    name: 'Systematic Credit — IG & HY',
    strategy: 'systematic_credit',
    office: 'New York',
    region: 'americas',
    pm: 'A. Okafor',
    currentAllocationMm: 0,
    onboarded: '2026-Q3',
  },
  'mlp-pod-2210': {
    name: 'Fundamental Equity L/S — Healthcare',
    strategy: 'fundamental_equity_ls',
    office: 'New York',
    region: 'americas',
    pm: 'R. Feldman',
    currentAllocationMm: 640,
    onboarded: '2019-Q1',
  },
  'mlp-pod-3384': {
    name: 'Quantitative Equity — Statistical Arbitrage',
    strategy: 'quant_equity',
    office: 'London',
    region: 'emea',
    pm: 'P. Sørensen',
    currentAllocationMm: 1120,
    onboarded: '2016-Q4',
  },
  'mlp-pod-1902': {
    name: 'Rates & Macro Relative Value',
    strategy: 'rates_macro_rv',
    office: 'Singapore',
    region: 'apac',
    pm: 'W. Tan',
    currentAllocationMm: 480,
    onboarded: '2021-Q2',
  },
  'mlp-pod-2876': {
    name: 'Commodities — Energy',
    strategy: 'commodities',
    office: 'Houston',
    region: 'americas',
    pm: 'D. Reyes',
    currentAllocationMm: 310,
    onboarded: '2022-Q3',
  },
};

/**
 * Strategies the allocation console lets a pod be tagged with.
 */
const STRATEGIES = {
  fundamental_equity_ls: { label: 'Fundamental Equity Long/Short' },
  quant_equity: { label: 'Quantitative Equity' },
  rates_macro_rv: { label: 'Rates & Macro Relative Value' },
  commodities: { label: 'Commodities' },
  systematic_credit: { label: 'Systematic Credit' },
};

/**
 * Platform risk limits by strategy, applied to every allocation before it
 * reaches the risk committee.
 * BUG: Systematic Credit was onboarded as a strategy (STRATEGIES + the
 * mlp-pod-4127 pod) but never received a row here, so lookups for it
 * resolve `undefined`.
 */
const RISK_LIMITS = {
  fundamental_equity_ls: { grossLeverageMax: 5.0, netExposurePct: 25, dailyVar99Bps: 45, liquidityDays: 3 },
  quant_equity: { grossLeverageMax: 8.0, netExposurePct: 5, dailyVar99Bps: 30, liquidityDays: 1 },
  rates_macro_rv: { grossLeverageMax: 12.0, netExposurePct: 40, dailyVar99Bps: 55, liquidityDays: 2 },
  commodities: { grossLeverageMax: 4.0, netExposurePct: 35, dailyVar99Bps: 60, liquidityDays: 2 },
};

/**
 * Platform-wide drawdown framework (bps of allocated capital).
 */
const DRAWDOWN_FRAMEWORK = {
  standard: { label: 'Standard', reduceAtBps: 500, reduceToPct: 50, stopAtBps: 750 },
  enhanced: { label: 'Enhanced (new pods, first 12 months)', reduceAtBps: 350, reduceToPct: 50, stopAtBps: 500 },
};

const CAPITAL_SOURCES = {
  platform: { label: 'New platform allocation' },
  reallocation: { label: 'Reallocation from existing book' },
};

const EFFECTIVE_DATES = {
  next_business_day: { label: 'Next business day', offsetDays: 1 },
  month_start: { label: 'Start of next month', offsetDays: null },
};

const ALLOCATION_MIN_MM = 25;
const ALLOCATION_MAX_MM = 2500;
const LEVERAGE_MIN = 1;
const LEVERAGE_MAX = 15;

/**
 * Resolves the pod for a request.
 */
function resolvePod(podId) {
  const pod = PODS[podId];
  if (!pod) {
    throw Object.assign(new Error(`Unknown investment team: ${podId}`), { code: 'INVALID_POD' });
  }
  return pod;
}

/**
 * Sizes the exposure and VaR budgets for the request against the strategy's
 * platform limits.
 * BUG: RISK_LIMITS has no systematic_credit row, so `limits.grossLeverageMax` crashes.
 */
function computeRiskLimits(pod, allocationMm, targetLeverage, riskFramework) {
  const limits = RISK_LIMITS[pod.strategy];
  const drawdown = DRAWDOWN_FRAMEWORK[riskFramework];
  const leverageHeadroom = limits.grossLeverageMax - targetLeverage;
  const grossExposureMm = Math.round(allocationMm * targetLeverage);
  const grossLimitMm = Math.round(allocationMm * limits.grossLeverageMax);
  const netExposureLimitMm = Math.round((allocationMm * limits.netExposurePct) / 100);
  const dailyVar99Mm = Math.round(allocationMm * limits.dailyVar99Bps) / 10000;
  return {
    strategy: pod.strategy,
    grossExposureMm,
    grossLimitMm,
    grossLeverageMax: limits.grossLeverageMax,
    leverageHeadroom: Math.round(leverageHeadroom * 100) / 100,
    withinLeverageLimit: leverageHeadroom >= 0,
    netExposureLimitMm,
    dailyVar99Mm: Math.round(dailyVar99Mm * 100) / 100,
    dailyVar99Bps: limits.dailyVar99Bps,
    liquidityDays: limits.liquidityDays,
    drawdown: {
      framework: drawdown.label,
      reduceAtMm: Math.round((allocationMm * drawdown.reduceAtBps) / 10000 * 100) / 100,
      reduceToPct: drawdown.reduceToPct,
      stopAtMm: Math.round((allocationMm * drawdown.stopAtBps) / 10000 * 100) / 100,
    },
  };
}

function effectiveDateFor(code) {
  const d = new Date();
  const opt = EFFECTIVE_DATES[code];
  if (opt.offsetDays === null) {
    d.setUTCMonth(d.getUTCMonth() + 1, 1);
  } else {
    d.setUTCDate(d.getUTCDate() + opt.offsetDays);
  }
  return d.toISOString().slice(0, 10);
}

function approvalChain(pod, allocationMm, risk) {
  const chain = ['Pod Risk Manager', 'Strategy Head'];
  if (allocationMm >= 500 || !risk.withinLeverageLimit) chain.push('Risk Committee');
  if (allocationMm >= 1000) chain.push('Co-CIO Office');
  return chain;
}

/**
 * Submits a capital allocation request for an investment team.
 */
async function submitAllocation(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Submitting Millennium capital allocation request', {
    requestId,
    podId: data.podId,
    allocationMm: data.allocationMm,
    targetLeverage: data.targetLeverage,
    riskFramework: data.riskFramework,
    capitalSource: data.capitalSource,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const pod = resolvePod(data.podId);
    const risk = computeRiskLimits(pod, data.allocationMm, data.targetLeverage, data.riskFramework);

    const duration = Date.now() - startTime;

    incrementMetric('allocation.submit.success', {
      route: ROUTE,
      strategy: pod.strategy,
      region: pod.region,
      riskFramework: data.riskFramework,
    });
    recordTiming('allocation.submit.latency', duration, { route: ROUTE });

    return {
      success: true,
      requestId,
      requesterName: data.requesterName,
      pod: {
        podId: data.podId,
        name: pod.name,
        strategy: STRATEGIES[pod.strategy].label,
        office: pod.office,
        pm: pod.pm,
        currentAllocationMm: pod.currentAllocationMm,
        proposedAllocationMm: pod.currentAllocationMm + data.allocationMm,
      },
      allocation: {
        requestedMm: data.allocationMm,
        targetLeverage: data.targetLeverage,
        capitalSource: CAPITAL_SOURCES[data.capitalSource].label,
        effectiveDate: effectiveDateFor(data.effectiveDate),
      },
      risk,
      approvals: approvalChain(pod, data.allocationMm, risk),
      status: 'pending_risk_review',
      nextStep: 'Risk will confirm limits and the allocation posts to the pod\u2019s book on the effective date.',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('allocation.submit.failure', {
      route: ROUTE,
      errorClass: error.name,
      podId: data.podId,
      riskFramework: data.riskFramework,
    });
    recordTiming('allocation.submit.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Millennium capital allocation request failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      podId: data.podId,
      allocationMm: data.allocationMm,
      targetLeverage: data.targetLeverage,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, source: 'millennium-allocation-console' },
      extra: {
        requestId,
        podId: data.podId,
        allocationMm: data.allocationMm,
        targetLeverage: data.targetLeverage,
        riskFramework: data.riskFramework,
        capitalSource: data.capitalSource,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/ff27e25f.js \u2014 computeRiskLimits',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: 'ff27e25f',
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Millennium — Pod Capital Allocation',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
      ],
      extra: {
        requestId,
        podId: data.podId,
        allocationMm: data.allocationMm,
        targetLeverage: data.targetLeverage,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@1.0.0`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Millennium allocation error', { error: err.message });
    });

    throw error;
  }
}

module.exports = {
  submitAllocation,
  resolvePod,
  computeRiskLimits,
  PODS,
  STRATEGIES,
  RISK_LIMITS,
  DRAWDOWN_FRAMEWORK,
  CAPITAL_SOURCES,
  EFFECTIVE_DATES,
  ALLOCATION_MIN_MM,
  ALLOCATION_MAX_MM,
  LEVERAGE_MIN,
  LEVERAGE_MAX,
};
