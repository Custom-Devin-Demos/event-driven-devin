const express = require('express');
const {
  APP_SERVICE,
  MONITOR_PATH,
  parseMonitorAlert,
  raiseLatencyWarning,
} = require('../../services/verticals/ca41ec6f');

const router = express.Router();

// One warning per cooldown: the monitor stays in WARN while the rush replays, and re-running the
// demo after the cooldown raises a fresh alert.
const parsedCooldown = parseInt(process.env.DOCTOLIB_SEARCH_ALERT_COOLDOWN_SECONDS, 10);
const COOLDOWN_MS = (Number.isNaN(parsedCooldown) ? 60 : parsedCooldown) * 1000;
const parsedMax = parseInt(process.env.DOCTOLIB_SEARCH_ALERT_MAX_PER_HOUR, 10);
const MAX_PER_HOUR = Number.isNaN(parsedMax) ? 10 : parsedMax;
const acceptedAt = [];

function reserveAlertSlot(now = Date.now()) {
  while (acceptedAt.length > 0 && acceptedAt[0] < now - 3600000) acceptedAt.shift();
  const last = acceptedAt[acceptedAt.length - 1];
  if (last !== undefined && now - last < COOLDOWN_MS) return { ok: false, retryAfterMs: COOLDOWN_MS - (now - last) };
  if (acceptedAt.length >= MAX_PER_HOUR) return { ok: false, retryAfterMs: acceptedAt[0] + 3600000 - now };
  acceptedAt.push(now);
  return { ok: true };
}

function resetAlertSlots() {
  acceptedAt.length = 0;
}

router.post(MONITOR_PATH, (req, res) => {
  if (req.get('x-synthetic')) return res.status(204).end();
  const alert = parseMonitorAlert(req.body);
  if (!alert) {
    return res.status(400).json({
      received: false,
      status: 'rejected',
      error: `Expected service ${APP_SERVICE} with numeric p95Ms (>= warn threshold) and samples`,
    });
  }
  const slot = reserveAlertSlot();
  if (!slot.ok) {
    res.set('Retry-After', String(Math.ceil(slot.retryAfterMs / 1000)));
    return res.status(429).json({ received: false, status: 'throttled', error: 'Monitor already alerted recently' });
  }
  const { reference } = raiseLatencyWarning(alert);
  return res.status(202).json({
    received: true,
    status: 'accepted',
    reference,
    service: APP_SERVICE,
    sessionRequested: true,
    receivedAt: new Date().toISOString(),
  });
});

module.exports = router;
module.exports.reserveAlertSlot = reserveAlertSlot;
module.exports.resetAlertSlots = resetAlertSlots;
