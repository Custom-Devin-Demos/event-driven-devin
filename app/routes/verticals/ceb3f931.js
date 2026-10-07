const express = require('express');
const { launchForm, ROUTE } = require('../../services/verticals/ceb3f931');

const router = express.Router();

// Response mode the landing page launches new forms in. The builder exposes
// this as "Storage mode" on the create-form dialog.
const DEFAULT_RESPONSE_MODE = 'storage';

// The page carries no secret, so abuse of the public launch endpoint is
// bounded by this per-route sliding window on top of the global session cap.
const parsedMax = parseInt(process.env.REPORT_CAP_CEB3F931_MAX, 10);
const REPORT_MAX = Number.isNaN(parsedMax) ? 10 : parsedMax;
const parsedWindow = parseInt(process.env.REPORT_CAP_CEB3F931_WINDOW_MINUTES, 10);
const REPORT_WINDOW_MS = (Number.isNaN(parsedWindow) ? 10 : parsedWindow) * 60 * 1000;
const acceptedAt = [];

function reserveReportSlot(now = Date.now()) {
  const cutoff = now - REPORT_WINDOW_MS;
  while (acceptedAt.length > 0 && acceptedAt[0] < cutoff) acceptedAt.shift();
  if (acceptedAt.length >= REPORT_MAX) return false;
  acceptedAt.push(now);
  return true;
}

/**
 * POST /api/ceb3f931/launch — launch a new form from the landing page.
 */
router.post(ROUTE, async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  if (!reserveReportSlot()) {
    res.set('Retry-After', String(Math.ceil(REPORT_WINDOW_MS / 1000)));
    return res.status(429).json({
      success: false,
      error: 'Form launch cap reached; retry later',
      code: 'LAUNCH_THROTTLED',
      requestId: req.requestId,
    });
  }

  try {
    const result = await launchForm({
      action: body.action || 'Start building your form now',
      title: body.formTitle || 'Untitled form',
      responseMode: body.responseMode || DEFAULT_RESPONSE_MODE,
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'LAUNCH_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
module.exports.reserveReportSlot = reserveReportSlot;
module.exports.DEFAULT_RESPONSE_MODE = DEFAULT_RESPONSE_MODE;
