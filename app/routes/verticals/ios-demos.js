const express = require('express');
const {
  APP_SERVICE,
  IOS_ERROR_PATH,
  SLUG_PATTERN,
  isAppReport,
  reportAppFailure,
  sourceFor,
} = require('../../services/verticals/ios-demos');

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

router.options(IOS_ERROR_PATH, allowCrossOrigin);

function parseLimit(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

const REPORT_MAX = parseLimit(process.env.REPORT_CAP_IOS_DEMOS_MAX, 10);
const REPORT_PER_SLUG_MAX = parseLimit(process.env.REPORT_CAP_IOS_DEMOS_PER_SLUG_MAX, 3);
const REPORT_WINDOW_MS = parseLimit(process.env.REPORT_CAP_IOS_DEMOS_WINDOW_MINUTES, 10) * 60 * 1000;
const acceptedAt = [];
const acceptedBySlug = new Map();

function pruneSlots(slots, cutoff) {
  while (slots.length > 0 && slots[0] <= cutoff) slots.shift();
}

function reserveReportSlot(slug, now = Date.now()) {
  const cutoff = now - REPORT_WINDOW_MS;
  pruneSlots(acceptedAt, cutoff);
  for (const [acceptedSlug, slots] of acceptedBySlug) {
    pruneSlots(slots, cutoff);
    if (slots.length === 0) acceptedBySlug.delete(acceptedSlug);
  }

  const slugSlots = acceptedBySlug.get(slug) || [];
  if (acceptedAt.length >= REPORT_MAX || slugSlots.length >= REPORT_PER_SLUG_MAX) return false;

  acceptedAt.push(now);
  slugSlots.push(now);
  acceptedBySlug.set(slug, slugSlots);
  return true;
}

router.post(IOS_ERROR_PATH, allowCrossOrigin, (req, res) => {
  const { slug } = req.params;
  if (!SLUG_PATTERN.test(slug)) {
    return res.status(400).json({
      received: false,
      status: 'rejected',
      error: 'Unknown demo slug',
    });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (!isAppReport(slug, body)) {
    return res.status(400).json({
      received: false,
      status: 'rejected',
      error: `Expected source ${sourceFor(slug)} with service ${APP_SERVICE}`,
    });
  }

  if (!reserveReportSlot(slug)) {
    res.set('Retry-After', String(Math.ceil(REPORT_WINDOW_MS / 1000)));
    return res.status(429).json({
      received: false,
      status: 'throttled',
      error: `Report cap reached for ${APP_SERVICE}; retry later`,
    });
  }

  const { reference } = reportAppFailure(slug, body);
  return res.status(202).json({
    received: true,
    status: 'accepted',
    reference,
    service: APP_SERVICE,
    sessionRequested: true,
    receivedAt: new Date().toISOString(),
    slug,
  });
});

module.exports = router;
module.exports.reserveReportSlot = reserveReportSlot;
