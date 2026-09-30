const express = require('express');
const path = require('path');
const {
  submitDispute,
  CARDS,
  APP_SERVICE,
  APP_SOURCE_PREFIX,
  IOS_ERROR_PATH,
  isAppReport,
  reportAppFailure,
} = require('../../services/verticals/westpac');

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

const parsedMax = parseInt(process.env.REPORT_CAP_WESTPAC_IOS_MAX, 10);
const REPORT_MAX = Number.isNaN(parsedMax) ? 10 : parsedMax;
const parsedWindow = parseInt(process.env.REPORT_CAP_WESTPAC_IOS_WINDOW_MINUTES, 10);
const REPORT_WINDOW_MS = (Number.isNaN(parsedWindow) ? 10 : parsedWindow) * 60 * 1000;
const acceptedAt = [];

function reserveReportSlot(now = Date.now()) {
  const cutoff = now - REPORT_WINDOW_MS;
  while (acceptedAt.length > 0 && acceptedAt[0] < cutoff) acceptedAt.shift();
  if (acceptedAt.length >= REPORT_MAX) return false;
  acceptedAt.push(now);
  return true;
}

router.post(IOS_ERROR_PATH, allowCrossOrigin, (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  if (!isAppReport(body)) {
    return res.status(400).json({
      received: false,
      status: 'rejected',
      error: `Expected a ${APP_SOURCE_PREFIX}<platform> source with service ${APP_SERVICE}`,
    });
  }

  if (!reserveReportSlot()) {
    res.set('Retry-After', String(Math.ceil(REPORT_WINDOW_MS / 1000)));
    return res.status(429).json({
      received: false,
      status: 'throttled',
      error: `Report cap reached for ${APP_SERVICE}; retry later`,
    });
  }

  const { reference } = reportAppFailure(body);

  return res.status(202).json({
    received: true,
    status: 'accepted',
    reference,
    service: APP_SERVICE,
    sessionRequested: true,
    receivedAt: new Date().toISOString(),
  });
});

router.get('/westpac', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', 'westpac.html'));
});

router.get('/api/westpac/cards', (_req, res) => {
  res.json({
    cards: Object.values(CARDS),
  });
});

router.post('/api/westpac/dispute', async (req, res) => {
  const body = req.body || {};
  const valueOrDefault = (key, fallback) => (
    Object.prototype.hasOwnProperty.call(body, key) ? body[key] : fallback
  );

  try {
    const dispute = await submitDispute({
      cardAccountNumber: valueOrDefault('cardAccountNumber', 'WBC-CC-4417-2280'),
      disputeReason: valueOrDefault('disputeReason', 'unauthorised'),
      merchantName: valueOrDefault('merchantName', 'LUMA TRAVEL SERVICES PTY LTD'),
      transactionDate: valueOrDefault('transactionDate', '2026-09-18'),
      transactionAmount: valueOrDefault('transactionAmount', 2480.75),
      cardPresent: valueOrDefault('cardPresent', false),
      contactedMerchant: valueOrDefault('contactedMerchant', true),
      cardLostOrStolen: valueOrDefault('cardLostOrStolen', false),
      contactNumber: valueOrDefault('contactNumber', '0438 662 105'),
      description: valueOrDefault(
        'description',
        'I did not authorise this charge. I have never used this merchant and my card has not left my wallet. I contacted the merchant on 20 September and they could not locate any booking in my name.',
      ),
      declaration: valueOrDefault('declaration', true),
      channel: body.channel,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(dispute);
  } catch (error) {
    if (error.statusCode === 400 || error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: error.message,
        errorClass: error.name,
        code: error.code || 'INVALID_DISPUTE_REQUEST',
        requestId: req.requestId,
      });
    }

    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'DISPUTE_LODGEMENT_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
module.exports.reserveReportSlot = reserveReportSlot;
