const express = require('express');
const path = require('path');
const { verifySessionSecret } = require('../../middleware/verify-session-secret');
const service = require('../../services/verticals/f63013c0');
const psp = require('../../services/verticals/f63013c0-meridian-psp');

const router = express.Router();

// Pages live under app/public/verticals/f63013c0/rb/. Adding a page is one map
// entry plus one file; bare /f63013c0 deliberately serves nothing.
const PAGES = {
  retail: 'retail.html',
  ysl: 'ysl.html',
};
const PAGES_DIR = path.join(__dirname, '..', '..', 'public', 'verticals', 'f63013c0', 'rb');
for (const [key, file] of Object.entries(PAGES)) {
  router.get(`/f63013c0/rb/${key}`, (_req, res) => {
    res.sendFile(path.join(PAGES_DIR, file));
  });
}

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

router.get('/api/f63013c0/account', (_req, res) => {
  res.json({ success: true, ...service.getAccount() });
});

router.get('/api/f63013c0/catalog', (_req, res) => {
  res.json({ success: true, ...service.getCatalog() });
});

router.get('/api/f63013c0/metrics', (_req, res) => {
  res.json({ success: true, ...service.getMetrics() });
});

router.get('/api/f63013c0/health', (_req, res) => {
  res.json({ success: true, status: 'ok' });
});

router.post('/api/f63013c0/checkout', verifySessionSecret, async (req, res) => {
  const body = req.body || {};
  try {
    const result = await service.checkout({
      customerId: text(body.customerId, 64),
      cartId: text(body.cartId, 64),
      addressId: text(body.addressId, 64),
      lines: Array.isArray(body.lines) ? body.lines : (Array.isArray(body.basket) ? body.basket : []),
      paymentMethod: text(body.paymentMethod, 16) || (body.payment && body.payment.method) || 'card',
      cardToken: text(body.cardToken, 128) || (body.payment && body.payment.cardToken) || undefined,
      shipping: body.shipping && typeof body.shipping === 'object' ? body.shipping : undefined,
      gift: body.gift && typeof body.gift === 'object' ? body.gift : undefined,
      devinUserId: text(body.devinUserId, 128) || undefined,
      devinOrgId: text(body.devinOrgId, 128) || undefined,
      devinEmail: text(body.devinEmail, 254) || undefined,
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
        message: "Your payment couldn't be processed. Please try again.",
        requestId: error.requestId || req.requestId,
      });
    }
    return res.status(error.statusCode || 500).json({
      success: false,
      code: error.code || 'CHECKOUT_FAILED',
      message: 'Checkout failed.',
      requestId: error.requestId || req.requestId,
    });
  }
});

router.get('/api/f63013c0/orders/:id', (req, res) => {
  const order = service.getOrder(req.params.id);
  if (!order) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Order not found' });
  return res.json({ success: true, order });
});

// Reconciliation hook: complete a stranded pending order with its PSP reference.
router.post('/api/f63013c0/orders/:id/complete', (req, res) => {
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

router.post('/api/f63013c0/psp/v1/payments', (req, res) => {
  const body = req.body || {};
  const { status, headers, body: responseBody } = psp.createPayment({
    amount: body.amount,
    currency: body.currency || 'USD',
    cardToken: text(body.cardToken, 128),
    reference: text(body.reference, 128),
  }, { idempotencyKey: text(req.headers['idempotency-key'], 255) || undefined });
  res.set(headers);
  return res.status(status).json(responseBody);
});

router.post('/api/f63013c0/psp/v1/payments/:id/void', (req, res) => {
  const auth = psp.voidPayment(req.params.id);
  if (!auth) {
    return res.status(404).json({ error: 'Authorization not found' });
  }
  return res.json({ id: auth.id, status: auth.status, voidedAt: auth.voidedAt });
});

router.get('/api/f63013c0/psp/v1/authorizations', (req, res) => {
  const authorizations = psp.listAuthorizations({
    since: text(req.query.since, 64) || undefined,
    cardToken: text(req.query.cardToken, 128) || undefined,
  });
  return res.json({ authorizations });
});

router.get('/api/f63013c0/psp/admin/version', (_req, res) => {
  res.json({ version: psp.getVersion(), flipAt: psp.getFlipAt() });
});

router.post('/api/f63013c0/psp/admin/version', (req, res) => {
  try {
    const version = psp.setVersion(text((req.body || {}).version, 16));
    return res.json({ version });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

router.post('/api/f63013c0/psp/admin/reset', (_req, res) => {
  psp.reset();
  res.json({ ok: true, version: psp.getVersion() });
});

// ---- Demo controls ----

router.post('/api/f63013c0/demo/reset', (_req, res) => {
  res.json({ success: true, state: service.reset() });
});

router.post('/api/f63013c0/demo/start', (req, res) => {
  const body = req.body || {};
  const state = service.startTraffic({
    rate: Number(body.rate) || undefined,
    retryPct: body.retryPct === undefined ? undefined : Number(body.retryPct),
    flipAfterSeconds: body.flipAfterSeconds === undefined ? undefined : Number(body.flipAfterSeconds),
  });
  res.json({ success: true, state });
});

router.post('/api/f63013c0/demo/stop', (_req, res) => {
  res.json({ success: true, state: service.stopTraffic() });
});

router.post('/api/f63013c0/demo/flip', (_req, res) => {
  psp.setVersion('2026-10');
  res.json({ success: true, state: service.getMetrics() });
});

router.post('/api/f63013c0/demo/unflip', (_req, res) => {
  psp.setVersion('2025-06');
  res.json({ success: true, state: service.getMetrics() });
});

module.exports = router;
