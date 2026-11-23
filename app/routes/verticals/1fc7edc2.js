const express = require('express');
const { getAccount, requestPlan, getPlan } = require('../../services/verticals/1fc7edc2');

const router = express.Router();

// `reports: 'off'` (or `?reports=off` on the page) keeps the failure but skips Sentry alerting/Slack/Devin; `x-synthetic` is local-only.
const alertsSuppressed = req => (req.body && req.body.reports === 'off')
  || (Boolean(req.headers['x-synthetic']) && process.env.NODE_ENV !== 'production');
const str = v => (typeof v === 'string' && v ? v : undefined);

function sendError(req, res, error, fallbackCode) {
  res.status(error.status || 500).json({
    success: false, error: error.message, errorClass: error.name, field: error.field,
    code: error.code || fallbackCode, reference: error.reference, requestId: req.requestId,
  });
}

router.get('/api/1fc7edc2/account', (_req, res) => res.json(getAccount()));

router.post('/api/1fc7edc2/installment-plans', async (req, res) => {
  const body = req.body || {};
  try {
    res.json(await requestPlan({
      chargeId: body.chargeId, payments: body.payments, suppressAlerts: alertsSuppressed(req),
      devinUserId: str(body.devinUserId), devinOrgId: str(body.devinOrgId), devinEmail: str(body.devinEmail),
    }));
  } catch (error) {
    sendError(req, res, error, 'INSTALLMENT_PLAN_FAILED');
  }
});

router.get('/api/1fc7edc2/installment-plans/:planId', (req, res) => {
  try {
    res.json(getPlan(req.params.planId));
  } catch (error) {
    sendError(req, res, error, 'PLAN_LOOKUP_FAILED');
  }
});

module.exports = router;
