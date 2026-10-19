const express = require('express');
const {
  ERROR_PATH,
  findPendingReport,
  findRecentReport,
  isAppReport,
  reportAppFailure,
} = require('../../services/verticals/lpl-clientworks');

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

router.options(ERROR_PATH, allowCrossOrigin);

const parsedMax = parseInt(process.env.REPORT_CAP_LPL_CLIENTWORKS_MAX, 10);
const REPORT_MAX = Number.isNaN(parsedMax) ? 10 : parsedMax;
const parsedWindow = parseInt(process.env.REPORT_CAP_LPL_CLIENTWORKS_WINDOW_MINUTES, 10);
const REPORT_WINDOW_MS = (Number.isNaN(parsedWindow) ? 10 : parsedWindow) * 60 * 1000;
const acceptedAt = [];
const PENDING_RETRY_AFTER_SECONDS = 5;
let pendingWaitMs = 8000;

// Each accepted report holds its own slot object (released by identity, never by timestamp).
function reserveReportSlot(now = Date.now()) {
  const cutoff = now - REPORT_WINDOW_MS;
  while (acceptedAt.length > 0 && acceptedAt[0].at <= cutoff) acceptedAt.shift();
  if (acceptedAt.length >= REPORT_MAX) return false;
  const slot = { at: now };
  acceptedAt.push(slot);
  return slot;
}

// A report whose alert/session was not delivered gives its slot back so retries stay possible.
function releaseReportSlot(slot) {
  const index = acceptedAt.indexOf(slot);
  if (index !== -1) acceptedAt.splice(index, 1);
}

// Seconds until the oldest accepted report leaves the window and a slot opens again.
function retryAfterSeconds(now = Date.now()) {
  const oldest = acceptedAt.length > 0 ? acceptedAt[0].at : now;
  return Math.max(1, Math.ceil((oldest + REPORT_WINDOW_MS - now) / 1000));
}

/**
 * POST /api/lpl/clientworks/error — a positions-grid failure reported by ClientWorks (web) or Account View
 * (iOS), both in COG-GTM/lpl-clientworks-legacy. Raises the Slack alert and the Devin remediation session.
 */
router.post(ERROR_PATH, allowCrossOrigin, async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};

  if (!isAppReport(body)) {
    return res.status(400).json({
      accepted: false,
      error: 'Expected source clientworks/web or clientworks/ios with the matching service and platform, a .NET errorType, and an optional CW-<8 hex> reference',
    });
  }

  // A resend while the first copy is still being delivered waits for that outcome instead of being acknowledged early.
  // After a failed delivery only the first waiter to resume re-dispatches (synchronously registering a new pending
  // entry); the others find that entry and keep waiting on it.
  const deadline = Date.now() + pendingWaitMs;
  for (let inFlight = findPendingReport(body); inFlight; inFlight = findPendingReport(body)) {
    let timer;
    const settled = await Promise.race([
      inFlight.pending,
      new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), Math.max(0, deadline - Date.now())); }),
    ]);
    clearTimeout(timer);
    if (settled === 'timeout') {
      res.set('Retry-After', String(PENDING_RETRY_AFTER_SECONDS));
      return res.status(503).json({ accepted: false, pending: true, error: 'The original report is still being delivered; retry later', retryAfterSeconds: PENDING_RETRY_AFTER_SECONDS });
    }
  }

  const duplicate = findRecentReport(body);
  if (duplicate) {
    return res.status(200).json({ accepted: true, duplicate: true, reference: duplicate.reference });
  }

  const slot = reserveReportSlot();
  if (slot === false) {
    const retryAfter = retryAfterSeconds();
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ accepted: false, error: 'Report cap reached; retry later', retryAfterSeconds: retryAfter });
  }

  const { reference, sessionPromise } = reportAppFailure(body);
  sessionPromise.then((delivered) => { if (!delivered) releaseReportSlot(slot); });

  return res.status(202).json({ accepted: true, reference });
});

module.exports = router;
module.exports.reserveReportSlot = reserveReportSlot;
module.exports.retryAfterSeconds = retryAfterSeconds;
module.exports.releaseReportSlot = releaseReportSlot;
module.exports._setPendingWaitMs = (ms) => { pendingWaitMs = ms; };
module.exports._resetReportCap = () => { acceptedAt.length = 0; };
