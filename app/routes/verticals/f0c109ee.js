const express = require('express');
const { submitClaim, ValidationError, MEMBER, POLICIES } = require('../../services/verticals/f0c109ee');

const logger = require('../../telemetry/logger');

const router = express.Router();

// Per-IP sliding-hour cap: each alert posts to Slack and can start a Devin session.
const ALERT_HOURLY_CAP = 50;
const ALERT_WINDOW_MS = 60 * 60 * 1000;
const alertWindows = new Map();

function alertAllowed(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = typeof forwarded === 'string' && forwarded.trim()
    ? forwarded.split(',').pop().trim()
    : (req.socket.remoteAddress || 'unknown');
  const now = Date.now();
  for (const [key, window] of alertWindows) {
    while (window.length && window[0] <= now - ALERT_WINDOW_MS) window.shift();
    if (!window.length) alertWindows.delete(key);
  }
  const window = alertWindows.get(ip) || [];
  if (window.length >= ALERT_HOURLY_CAP) {
    logger.warn('Benefits claim alert skipped — hourly cap hit', { ip, limit: ALERT_HOURLY_CAP });
    return false;
  }
  window.push(now);
  alertWindows.set(ip, window);
  return true;
}

router.get('/api/f0c109ee/coverage', (_req, res) => {
  res.json({
    member: MEMBER,
    policies: Object.entries(POLICIES).map(([policyId, policy]) => ({
      policyId,
      claimType: policy.claimType,
      planName: policy.planName,
      coverageTier: policy.coverageTier,
      status: policy.status,
    })),
  });
});

router.post('/api/f0c109ee/claims', async (req, res) => {
  const body = req.body || {};
  try {
    res.json(await submitClaim({
      policyId: body.policyId,
      claimType: body.claimType,
      amount: body.amount,
      description: body.description,
      serviceDate: body.serviceDate,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    }, { shouldAlert: () => alertAllowed(req) }));
  } catch (error) {
    const status = error instanceof ValidationError ? 400 : 500;
    res.status(status).json({
      success: false,
      error: status === 400 ? error.message : 'We couldn\u2019t submit your claim right now. Please try again in a few minutes.',
      errorClass: error.name,
      claimId: error.claimId || null,
      requestId: error.claimId || req.requestId || null,
    });
  }
});

module.exports = router;
module.exports.ALERT_HOURLY_CAP = ALERT_HOURLY_CAP;
