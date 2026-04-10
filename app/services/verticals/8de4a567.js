const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * In-memory bug toggle.
 * When `true`, the credit score refresh uses a mismatched property path
 * that throws a TypeError — exactly the kind of shape mismatch that
 * passes code review but crashes in production.
 * Reset via POST /api/8de4a567/reset
 */
let bugActive = true;

/**
 * User credit profile for the demo
 */
const CREDIT_PROFILE = {
  userId: 'usr_ck_jordan',
  name: 'Jordan Hayes',
  memberSince: '2021',
  bureau: 'TransUnion',
  lastUpdated: '2026-03-22',
  accounts: {
    totalOpen: 12,
    revolving: 5,
    installment: 4,
    mortgage: 1,
    auto: 2,
  },
  balances: {
    totalDebt: 142800,
    creditLimit: 68500,
    mortgageBalance: 118400,
    autoBalance: 18200,
    studentLoan: 0,
  },
};

/**
 * Credit score factors and their raw values
 */
const SCORE_FACTORS = {
  paymentHistory: { label: 'Payment History', value: 98.5, maxPoints: 100, status: 'excellent' },
  creditUtilization: { label: 'Credit Utilization', value: 24, maxPoints: 100, unit: '%', status: 'good' },
  creditAge: { label: 'Credit Age', value: 7.2, maxPoints: 10, unit: 'yrs', status: 'good' },
  totalAccounts: { label: 'Total Accounts', value: 12, maxPoints: 25, status: 'good' },
  hardInquiries: { label: 'Hard Inquiries', value: 2, maxPoints: 10, status: 'good' },
  derogatoryMarks: { label: 'Derogatory Marks', value: 0, maxPoints: 5, status: 'excellent' },
};

/**
 * Recommendations based on credit profile
 */
const RECOMMENDATIONS = [
  { id: 'cc-1', type: 'Credit Card', name: 'Sapphire Reserve', issuer: 'Chase', apr: '21.49% - 28.49%', reward: '3x points on travel & dining', approvalOdds: 'Very Good', annualFee: '$550' },
  { id: 'cc-2', type: 'Credit Card', name: 'Gold Card', issuer: 'American Express', apr: '21.99% - 29.99%', reward: '4x points on restaurants', approvalOdds: 'Very Good', annualFee: '$250' },
  { id: 'loan-1', type: 'Personal Loan', name: 'Fixed Rate Loan', issuer: 'SoFi', apr: '8.99% - 14.49%', reward: 'No origination fees', approvalOdds: 'Good', annualFee: 'None' },
  { id: 'auto-1', type: 'Auto Refinance', name: 'Auto Refi', issuer: 'Capital One', apr: '5.49% - 9.99%', reward: 'Save up to $50/mo', approvalOdds: 'Excellent', annualFee: 'None' },
];

/**
 * FICO weight map (industry-standard weights).
 * Payment history: 35%, Utilization: 30%, Credit age: 15%,
 * Account mix: 10%, New credit: 10%
 */
const WEIGHTS = {
  paymentHistory: 0.35,
  creditUtilization: 0.30,
  creditAge: 0.15,
  totalAccounts: 0.10,
  hardInquiries: 0.10,
};

/**
 * Load the scoring model configuration.
 *
 * Returns the weights nested under a `model` key.
 */
function loadScoringModel() {
  return {
    model: {
      weights: WEIGHTS,
      version: '3.0',
    },
    metadata: {
      lastCalibrated: '2026-03-01',
      source: 'fico-bureau-v3',
    },
  };
}

/**
 * Extract weights from the scoring model config.
 *
 * BUG: This function accesses `config.scoring.weights` but
 * loadScoringModel() returns the weights under `config.model.weights`.
 * The property `config.scoring` is undefined, so `.weights` throws:
 *   TypeError: Cannot read properties of undefined (reading 'weights')
 *
 * This is the same class of bug as the other verticals — a shape mismatch
 * between producer and consumer that passes code review but crashes at runtime.
 */
function extractWeights(config) {
  const modelConfig = config.scoring;
  return modelConfig.weights;
}

/**
 * Normalize a raw factor value to a 0-1 scale.
 */
function normalizeFactor(factor) {
  const { value, maxPoints, label } = factor;
  if (label === 'Credit Utilization') {
    // Lower utilization is better — invert
    return Math.max(0, 1 - (value / maxPoints));
  }
  if (label === 'Hard Inquiries' || label === 'Derogatory Marks') {
    // Fewer is better — invert
    return Math.max(0, 1 - (value / maxPoints));
  }
  return Math.min(1, value / maxPoints);
}

/**
 * Calculate the credit score from raw factors and a weight map.
 */
function calculateCreditScore(factors, weights) {
  let weightedSum = 0;
  let totalWeight = 0;

  for (const [key, weight] of Object.entries(weights)) {
    const factor = factors[key];
    if (!factor) continue;
    const normalized = normalizeFactor(factor);
    weightedSum += normalized * weight;
    totalWeight += weight;
  }

  // Map the weighted average into the FICO range 300-850
  const baseScore = 300;
  const range = 550; // 850 - 300
  const rawScore = baseScore + Math.round(weightedSum / totalWeight * range);

  return Math.min(850, Math.max(300, rawScore));
}

/**
 * Determine score rating label and color.
 */
function getScoreRating(score) {
  if (score >= 800) return { label: 'Exceptional', color: '#00c853' };
  if (score >= 740) return { label: 'Very Good', color: '#2e7d32' };
  if (score >= 670) return { label: 'Good', color: '#ff9100' };
  if (score >= 580) return { label: 'Fair', color: '#ff6d00' };
  return { label: 'Poor', color: '#ff1744' };
}

/**
 * Fetch the full credit score report.
 * This endpoint always works (uses the correct path) so the dashboard loads.
 */
async function getCreditReport(data) {
  const startTime = Date.now();
  const reportId = uuidv4();

  logger.info('Generating credit report', {
    reportId,
    userId: data.userId || CREDIT_PROFILE.userId,
    bugActive,
    service: 'credit-score-api',
  });

  try {
    // Simulate bureau latency
    await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 150));

    // Always use the correct path for initial load
    const config = loadScoringModel();
    const weights = config.model.weights;
    const score = calculateCreditScore(SCORE_FACTORS, weights);
    const rating = getScoreRating(score);

    const duration = Date.now() - startTime;

    incrementMetric('creditscore.fetch.success', {
      route: '/api/8de4a567/score',
      bureau: CREDIT_PROFILE.bureau,
    });
    recordTiming('creditscore.fetch.latency', duration, {
      route: '/api/8de4a567/score',
    });

    return {
      success: true,
      reportId,
      score,
      rating,
      bugActive,
      profile: CREDIT_PROFILE,
      factors: SCORE_FACTORS,
      recommendations: RECOMMENDATIONS,
      generatedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('creditscore.fetch.failure', {
      route: '/api/8de4a567/score',
      errorClass: error.name,
    });
    recordTiming('creditscore.fetch.latency', duration, {
      route: '/api/8de4a567/score',
      error: 'true',
    });

    logger.error('Credit report generation failed', {
      reportId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/8de4a567/score',
        service: 'credit-score-api',
      },
      extra: { reportId, userId: data.userId },
    });

    throw error;
  }
}

/**
 * Refresh the credit score — the action that triggers the bug.
 *
 * When bugActive is true, this function calls extractWeights() which
 * accesses `config.scoring.weights` instead of `config.model.weights`,
 * throwing a TypeError.  The error is caught, reported to Sentry, and
 * triggers 3 parallel Devin sessions for cross-repo incident response.
 */
async function refreshScore(data) {
  const startTime = Date.now();
  const refreshId = uuidv4();

  logger.info('Refreshing credit score', {
    refreshId,
    userId: data.userId || CREDIT_PROFILE.userId,
    bugActive,
    service: 'credit-score-api',
  });

  try {
    // Simulate bureau API call
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const config = loadScoringModel();

    // BUG PATH: extractWeights accesses config.scoring.weights (undefined)
    // FIX PATH: direct access to config.model.weights (correct)
    const weights = bugActive
      ? extractWeights(config)
      : config.model.weights;

    const score = calculateCreditScore(SCORE_FACTORS, weights);
    const rating = getScoreRating(score);

    const duration = Date.now() - startTime;

    incrementMetric('creditscore.refresh.success', {
      route: '/api/8de4a567/refresh',
    });
    recordTiming('creditscore.refresh.latency', duration, {
      route: '/api/8de4a567/refresh',
    });

    return {
      success: true,
      refreshId,
      score,
      rating,
      bugActive,
      generatedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('creditscore.refresh.failure', {
      route: '/api/8de4a567/refresh',
      errorClass: error.name,
    });
    recordTiming('creditscore.refresh.latency', duration, {
      route: '/api/8de4a567/refresh',
      error: 'true',
    });

    logger.error('Credit score refresh failed', {
      refreshId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/8de4a567/refresh',
        service: 'credit-score-api',
      },
      extra: { refreshId, userId: data.userId || CREDIT_PROFILE.userId },
    });

    // Trigger multiple Devin sessions to simulate cross-repo incident response
    triggerMultiSessionIncident({
      error,
      refreshId,
      devinUserId: data.devinUserId,
      devinOrgId: data.devinOrgId,
      devinEmail: data.devinEmail,
    });

    throw error;
  }
}

/**
 * Trigger multiple parallel Devin sessions to simulate a real
 * cross-SDLC incident response.
 *
 * Session 1: Root cause analysis in the scoring service repo
 * Session 2: Data validation in the ETL pipeline repo
 * Session 3: Monitoring/alerting rules update
 *
 * Each session gets a unique issueTitle (prefixed with verticalLabel).
 */
function triggerMultiSessionIncident(incidentData) {
  const sessions = [
    {
      verticalLabel: 'Credit Score \u2014 Root Cause Fix',
      culprit: 'app/services/verticals/8de4a567.js \u2014 extractWeights',
      service: 'credit-score-api',
    },
    {
      verticalLabel: 'Credit Score \u2014 Data Pipeline Validation',
      culprit: 'etl/transforms/score_weights.py \u2014 apply_weights',
      service: 'etl-pipeline',
    },
    {
      verticalLabel: 'Credit Score \u2014 Monitoring & Alerts',
      culprit: 'infra/monitors/score_drift_monitor.tf \u2014 threshold_config',
      service: 'observability-platform',
    },
  ];

  for (const session of sessions) {
    createSessionAndAlert({
      issueTitle: `[${session.verticalLabel}] ${incidentData.error.name}: ${incidentData.error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: session.culprit,
      errorType: incidentData.error.name || 'TypeError',
      errorValue: incidentData.error.message,
      devinUserId: incidentData.devinUserId,
      devinEmail: incidentData.devinEmail,
      devinOrgId: incidentData.devinOrgId,
      service: session.service,
      verticalLabel: session.verticalLabel,
      tags: [
        { key: 'route', value: '/api/8de4a567/refresh' },
        { key: 'service', value: session.service },
        { key: 'severity', value: 'critical' },
      ],
      extra: {
        refreshId: incidentData.refreshId,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-8de4a567@2.4.1',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: 'credit-score-refresh-crash',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session for incident', {
        error: err.message,
        service: session.service,
      });
    });
  }
}

/**
 * Toggle the bug on or off and return the new state.
 */
function resetBug(active) {
  const previous = bugActive;
  bugActive = typeof active === 'boolean' ? active : !bugActive;
  logger.info('Bug state toggled', { previous, current: bugActive });
  return { previous, current: bugActive };
}

/**
 * Get current bug state.
 */
function getBugState() {
  return { bugActive };
}

module.exports = {
  getCreditReport,
  refreshScore,
  resetBug,
  getBugState,
  CREDIT_PROFILE,
  SCORE_FACTORS,
  RECOMMENDATIONS,
};
