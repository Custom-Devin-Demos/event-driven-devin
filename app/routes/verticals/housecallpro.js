const express = require('express');
const logger = require('../../telemetry/logger');
const { APP_SOURCE, BUG_REPORT_PATH, intakeChannel, isBugReport, postBugReport } = require('../../services/verticals/housecallpro');

const router = express.Router();

function allowCrossOrigin(req, res, next) {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, User-Agent',
    'Access-Control-Max-Age': '600',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
}

const parsedMax = parseInt(process.env.REPORT_CAP_HCP_IOS_MAX, 10);
const REPORT_MAX = Number.isNaN(parsedMax) ? 10 : parsedMax;
const parsedWindow = parseInt(process.env.REPORT_CAP_HCP_IOS_WINDOW_MINUTES, 10);
const REPORT_WINDOW_MS = (Number.isNaN(parsedWindow) ? 10 : parsedWindow) * 60 * 1000;
const acceptedAt = [];

function releaseReportSlot(at) {
  const index = acceptedAt.indexOf(at);
  if (index !== -1) acceptedAt.splice(index, 1);
}

function reserveReportSlot(now = Date.now()) {
  const cutoff = now - REPORT_WINDOW_MS;
  while (acceptedAt.length > 0 && acceptedAt[0] < cutoff) acceptedAt.shift();
  if (acceptedAt.length >= REPORT_MAX) return false;
  acceptedAt.push(now);
  return now;
}

router.options(BUG_REPORT_PATH, allowCrossOrigin);

router.post(BUG_REPORT_PATH, allowCrossOrigin, async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (!isBugReport(body)) {
    return res.status(400).json({ received: false, status: 'rejected', error: `Expected source ${APP_SOURCE} with a summary` });
  }
  const slot = reserveReportSlot();
  if (!slot) {
    res.set('Retry-After', String(Math.ceil(REPORT_WINDOW_MS / 1000)));
    return res.status(429).json({ received: false, status: 'throttled', error: 'Bug report cap reached; retry later' });
  }
  try {
    const result = await postBugReport(body);
    return res.status(202).json({
      received: true,
      status: 'posted',
      reference: result.reference,
      channel: intakeChannel(),
      receivedAt: new Date().toISOString(),
    });
  } catch (err) {
    releaseReportSlot(slot);
    logger.error('housecallpro: failed to post bug report', { error: err.message });
    return res.status(502).json({ received: false, status: 'error', error: 'Could not reach the intake channel' });
  }
});

router._resetReportCap = () => { acceptedAt.length = 0; };

module.exports = router;
