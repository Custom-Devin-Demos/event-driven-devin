const express = require('express');
const {
  submitAllocation,
  PODS,
  STRATEGIES,
  DRAWDOWN_FRAMEWORK,
  CAPITAL_SOURCES,
  EFFECTIVE_DATES,
  ALLOCATION_MIN_MM,
  ALLOCATION_MAX_MM,
  LEVERAGE_MIN,
  LEVERAGE_MAX,
} = require('../../services/verticals/ff27e25f');

const router = express.Router();

router.get('/api/ff27e25f/pods', (_req, res) => {
  res.json({
    pods: Object.entries(PODS).map(([podId, p]) => ({
      podId,
      name: p.name,
      strategy: p.strategy,
      strategyLabel: STRATEGIES[p.strategy].label,
      office: p.office,
      region: p.region,
      pm: p.pm,
      currentAllocationMm: p.currentAllocationMm,
      onboarded: p.onboarded,
    })),
    riskFrameworks: Object.entries(DRAWDOWN_FRAMEWORK).map(([code, f]) => ({ code, label: f.label })),
    capitalSources: Object.entries(CAPITAL_SOURCES).map(([code, s]) => ({ code, label: s.label })),
    effectiveDates: Object.entries(EFFECTIVE_DATES).map(([code, d]) => ({ code, label: d.label })),
    allocationRangeMm: [ALLOCATION_MIN_MM, ALLOCATION_MAX_MM],
    leverageRange: [LEVERAGE_MIN, LEVERAGE_MAX],
  });
});

function numberField(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

function stringField(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return typeof value === 'string' ? value : null;
}

function has(map, key) {
  return typeof key === 'string' && Object.hasOwn(map, key);
}

router.post('/api/ff27e25f/allocations', async (req, res) => {
  const requesterName = typeof req.body.requesterName === 'string' ? req.body.requesterName.trim() : '';
  const podId = stringField(req.body.podId, 'mlp-pod-4127');
  const allocationMm = numberField(req.body.allocationMm);
  const targetLeverage = numberField(req.body.targetLeverage);
  const riskFramework = stringField(req.body.riskFramework, 'standard');
  const capitalSource = stringField(req.body.capitalSource, 'platform');
  const effectiveDate = stringField(req.body.effectiveDate, 'next_business_day');

  if (!requesterName) {
    return res.status(400).json({ success: false, error: 'requesterName is required', code: 'VALIDATION_ERROR' });
  }
  if (!has(PODS, podId)) {
    return res.status(400).json({ success: false, error: `Unknown investment team: ${podId}`, code: 'VALIDATION_ERROR' });
  }
  if (!Number.isSafeInteger(allocationMm) || allocationMm < ALLOCATION_MIN_MM || allocationMm > ALLOCATION_MAX_MM) {
    return res.status(400).json({
      success: false,
      error: `allocationMm must be a whole number between ${ALLOCATION_MIN_MM} and ${ALLOCATION_MAX_MM} (USD millions)`,
      code: 'VALIDATION_ERROR',
    });
  }
  if (!Number.isFinite(targetLeverage) || targetLeverage < LEVERAGE_MIN || targetLeverage > LEVERAGE_MAX || Math.round(targetLeverage * 2) !== targetLeverage * 2) {
    return res.status(400).json({
      success: false,
      error: `targetLeverage must be between ${LEVERAGE_MIN}x and ${LEVERAGE_MAX}x in 0.5x steps`,
      code: 'VALIDATION_ERROR',
    });
  }
  if (!has(DRAWDOWN_FRAMEWORK, riskFramework)) {
    return res.status(400).json({ success: false, error: `Unknown risk framework: ${riskFramework}`, code: 'VALIDATION_ERROR' });
  }
  if (!has(CAPITAL_SOURCES, capitalSource)) {
    return res.status(400).json({ success: false, error: `Unknown capital source: ${capitalSource}`, code: 'VALIDATION_ERROR' });
  }
  if (!has(EFFECTIVE_DATES, effectiveDate)) {
    return res.status(400).json({ success: false, error: `Unknown effective date option: ${effectiveDate}`, code: 'VALIDATION_ERROR' });
  }

  try {
    const result = await submitAllocation({
      requesterName,
      podId,
      allocationMm,
      targetLeverage,
      riskFramework,
      capitalSource,
      effectiveDate,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'ALLOCATION_REQUEST_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
