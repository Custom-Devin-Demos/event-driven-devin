const express = require('express');
const { reserveTickets, ROUTE } = require('../../services/verticals/29f8340a');

const router = express.Router();

const DEFAULT_PASS_CODE = 'STACK26-EARLYBIRD';
const DEFAULT_ATTENDEE_TYPE = 'public';
const parsedMax = parseInt(process.env.REPORT_CAP_29F8340A_MAX, 10);
const REPORT_MAX = Number.isNaN(parsedMax) ? 10 : parsedMax;
const parsedWindow = parseInt(process.env.REPORT_CAP_29F8340A_WINDOW_MINUTES, 10);
const REPORT_WINDOW_MS = (Number.isNaN(parsedWindow) ? 10 : parsedWindow) * 60 * 1000;
const acceptedAt = [];

function reserveReportSlot(now = Date.now()) {
  const cutoff = now - REPORT_WINDOW_MS;
  while (acceptedAt.length > 0 && acceptedAt[0] < cutoff) acceptedAt.shift();
  if (acceptedAt.length >= REPORT_MAX) return false;
  acceptedAt.push(now);
  return true;
}

router.post(ROUTE, async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  if (!reserveReportSlot()) {
    res.set('Retry-After', String(Math.ceil(REPORT_WINDOW_MS / 1000)));
    return res.status(429).json({
      success: false,
      error: 'Ticket reservation cap reached; retry later',
      code: 'RESERVATION_THROTTLED',
      requestId: req.requestId,
    });
  }

  try {
    const result = await reserveTickets({
      action: body.action || 'Get your tickets',
      passCode: body.passCode || DEFAULT_PASS_CODE,
      attendeeType: body.attendeeType || DEFAULT_ATTENDEE_TYPE,
      quantity: body.quantity,
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'RESERVATION_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
module.exports.reserveReportSlot = reserveReportSlot;
module.exports.DEFAULT_PASS_CODE = DEFAULT_PASS_CODE;
