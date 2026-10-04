const express = require('express');
const path = require('path');
const { submitPayment, ACCOUNTS } = require('../../services/verticals/cba');
const {
  APP_SERVICE: IOS_APP_SERVICE,
  APP_SOURCE_PREFIX: IOS_APP_SOURCE_PREFIX,
  IOS_ERROR_PATH,
  isAppReport: isIosAppReport,
  reportAppFailure: reportIosAppFailure,
} = require('../../services/verticals/cba-ios');

const router = express.Router();

// Native CommBank iOS app report bridge (github.com/COG-GTM/event-driven-ios).
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

const parsedMax = parseInt(process.env.REPORT_CAP_CBA_IOS_MAX, 10);
const REPORT_MAX = Number.isNaN(parsedMax) ? 10 : parsedMax;
const parsedWindow = parseInt(process.env.REPORT_CAP_CBA_IOS_WINDOW_MINUTES, 10);
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

  if (!isIosAppReport(body)) {
    return res.status(400).json({
      received: false,
      status: 'rejected',
      error: `Expected a ${IOS_APP_SOURCE_PREFIX}<platform> source with service ${IOS_APP_SERVICE}`,
    });
  }

  if (!reserveReportSlot()) {
    res.set('Retry-After', String(Math.ceil(REPORT_WINDOW_MS / 1000)));
    return res.status(429).json({
      received: false,
      status: 'throttled',
      error: `Report cap reached for ${IOS_APP_SERVICE}; retry later`,
    });
  }

  const { reference } = reportIosAppFailure(body);

  return res.status(202).json({
    received: true,
    status: 'accepted',
    reference,
    service: IOS_APP_SERVICE,
    sessionRequested: true,
    receivedAt: new Date().toISOString(),
  });
});

// Reproduction mode lets a remediation session fail the payment on camera without
// re-raising the incident it was created from. It is ignored in production, so the
// header cannot silence a real CommBank failure on the hosted demo.
function isReproductionRequest(req) {
  return Boolean(req.headers['x-synthetic']) && process.env.NODE_ENV !== 'production';
}

router.get('/cba', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', 'cba.html'));
});

router.get('/api/cba/accounts', (_req, res) => {
  res.json({
    accounts: Object.values(ACCOUNTS).map((account) => ({
      accountNumber: account.accountNumber,
      productLabel: account.productLabel,
      holderName: account.holderName,
      balance: account.balance,
      dailyLimit: account.dailyLimit,
    })),
  });
});

router.post('/api/cba/payment', async (req, res) => {
  const body = req.body || {};
  const valueOrDefault = (key, fallback) => (
    Object.prototype.hasOwnProperty.call(body, key) ? body[key] : fallback
  );

  try {
    const payment = await submitPayment({
      fromAccount: valueOrDefault('fromAccount', '062-000 10345678'),
      paymentMethod: valueOrDefault('paymentMethod', 'payid'),
      payeeName: valueOrDefault('payeeName', 'Sunrise Plumbing Pty Ltd'),
      payeeBsb: body.payeeBsb,
      payeeAccount: body.payeeAccount,
      payId: valueOrDefault('payId', '54 692 411 003'),
      payIdType: valueOrDefault('payIdType', 'abn'),
      billerCode: body.billerCode,
      billerReference: body.billerReference,
      amount: valueOrDefault('amount', 1480),
      description: valueOrDefault('description', 'Invoice 80114'),
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
      synthetic: isReproductionRequest(req),
    });
    res.json(payment);
  } catch (error) {
    if (error.statusCode === 400 || error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: error.message,
        errorClass: error.name,
        code: error.code || 'INVALID_PAYMENT',
        requestId: error.requestId || req.requestId,
      });
    }

    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: 'PAYMENT_SETTLEMENT_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;
module.exports.reserveReportSlot = reserveReportSlot;
