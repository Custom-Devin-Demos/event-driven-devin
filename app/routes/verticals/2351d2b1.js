const express = require('express');
const { verifySessionSecret } = require('../../middleware/verify-session-secret');
const service = require('../../services/verticals/2351d2b1');
const psp = require('../../services/verticals/2351d2b1-meridian-psp');

// Carrefour — Courses en ligne (standalone demo). The page is served by the
// registry at /2351d2b1 and its alias /carrefour.
const router = express.Router();

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

const alertsOff = (req) => String(req.headers['x-demo-alerts'] || '').toLowerCase() === 'off'
  || req.query.reports === 'off';

router.get('/api/2351d2b1/catalog', (_req, res) => {
  res.json({ success: true, ...service.getCatalog() });
});

router.get('/api/2351d2b1/metrics', (_req, res) => {
  res.json({ success: true, ...service.getMetrics() });
});

router.get('/api/2351d2b1/health', (_req, res) => {
  res.json({ success: true, status: 'ok' });
});

router.post('/api/2351d2b1/checkout', verifySessionSecret, async (req, res) => {
  const body = req.body || {};
  try {
    const result = await service.checkout({
      customerId: text(body.customerId, 64),
      cartId: text(body.cartId, 64),
      addressId: text(body.addressId, 64),
      lines: Array.isArray(body.lines) ? body.lines : [],
      paymentMethod: text(body.paymentMethod, 16) || 'card',
      cardToken: text(body.cardToken, 128) || undefined,
      devinUserId: text(body.devinUserId, 128) || undefined,
      devinOrgId: text(body.devinOrgId, 128) || undefined,
      devinEmail: text(body.devinEmail, 254) || undefined,
      alertsOff: alertsOff(req),
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    if (error.statusCode === 400) {
      return res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: error.message,
      });
    }
    if (error.statusCode === 502) {
      return res.status(502).json({
        success: false,
        code: 'PAYMENT_FAILED',
        message: 'Votre paiement n’a pas pu aboutir. Veuillez réessayer.',
        requestId: error.requestId || req.requestId,
      });
    }
    return res.status(error.statusCode || 500).json({
      success: false,
      code: error.code || 'CHECKOUT_FAILED',
      message: 'La commande a échoué.',
      requestId: error.requestId || req.requestId,
    });
  }
});

router.get('/api/2351d2b1/orders/:id', (req, res) => {
  const order = service.getOrder(req.params.id);
  if (!order) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Order not found' });
  return res.json({ success: true, order });
});

// Reconciliation hook: complete a stranded pending order with its PSP reference.
router.post('/api/2351d2b1/orders/:id/complete', (req, res) => {
  const paymentId = text((req.body || {}).paymentId, 128);
  if (!paymentId) {
    return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'paymentId is required' });
  }
  const result = service.completeOrder(req.params.id, paymentId);
  if (result.error === 'not_found') {
    return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Order not found' });
  }
  if (result.error === 'not_pending') {
    return res.status(409).json({ success: false, code: 'NOT_PENDING', message: 'Order is not pending', order: result.order });
  }
  return res.json({ success: true, order: result.order });
});

// ---- Meridian Pay simulator (the vendor side of the wire) ----

router.post('/api/2351d2b1/psp/v1/payments', (req, res) => {
  const body = req.body || {};
  const { status, headers, body: responseBody } = psp.createPayment({
    amount: body.amount,
    currency: body.currency || 'EUR',
    descriptor: text(body.descriptor, 22) || undefined,
    cardToken: text(body.cardToken, 128),
    reference: text(body.reference, 128),
  }, { idempotencyKey: text(req.headers['idempotency-key'], 255) || undefined });
  res.set(headers);
  return res.status(status).json(responseBody);
});

router.post('/api/2351d2b1/psp/v1/payments/:id/void', (req, res) => {
  const auth = psp.voidPayment(req.params.id);
  if (!auth) {
    return res.status(404).json({ error: 'Authorization not found' });
  }
  return res.json({ id: auth.id, status: auth.status, voidedAt: auth.voidedAt });
});

router.get('/api/2351d2b1/psp/v1/authorizations', (req, res) => {
  const authorizations = psp.listAuthorizations({
    since: text(req.query.since, 64) || undefined,
    cardToken: text(req.query.cardToken, 128) || undefined,
  });
  return res.json({ authorizations });
});

router.get('/api/2351d2b1/psp/admin/version', (_req, res) => {
  res.json({ version: psp.getVersion() });
});

// ---- Demo controls ----

router.post('/api/2351d2b1/demo/reset', (_req, res) => {
  res.json({ success: true, state: service.reset() });
});

router.post('/api/2351d2b1/demo/flip', (_req, res) => {
  psp.setVersion('2026-10');
  res.json({ success: true, state: service.getMetrics() });
});

router.post('/api/2351d2b1/demo/unflip', (_req, res) => {
  psp.setVersion('2025-06');
  res.json({ success: true, state: service.getMetrics() });
});

module.exports = router;
