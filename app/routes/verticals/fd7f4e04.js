const express = require('express');
const {
  placeOrder,
  INVENTORY,
  FINANCING_TERMS,
  CREDIT_TIERS,
  DELIVERY_OPTIONS,
  PROTECTION_PLANS,
} = require('../../services/verticals/fd7f4e04');

const router = express.Router();

router.get('/api/fd7f4e04/inventory', (_req, res) => {
  res.json({
    vehicles: Object.entries(INVENTORY).map(([vehicleId, v]) => ({
      vehicleId,
      title: `${v.year} ${v.make} ${v.model} ${v.trim}`,
      bodyStyle: v.bodyStyle,
      mileage: v.mileage,
      price: v.price,
      kbbDelta: v.kbbDelta,
      location: v.location,
    })),
    terms: FINANCING_TERMS,
    creditTiers: Object.entries(CREDIT_TIERS).map(([code, t]) => ({ code, label: t.label })),
    deliveryOptions: Object.entries(DELIVERY_OPTIONS).map(([code, d]) => ({ code, label: d.label, fee: d.fee })),
    protectionPlans: Object.entries(PROTECTION_PLANS).map(([code, p]) => ({ code, label: p.label, price: p.price })),
  });
});

function nonNegativeInteger(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function stringField(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return typeof value === 'string' ? value : null;
}

function has(map, key) {
  return typeof key === 'string' && Object.hasOwn(map, key);
}

router.post('/api/fd7f4e04/orders', async (req, res) => {
  const buyerName = typeof req.body.buyerName === 'string' ? req.body.buyerName.trim() : '';
  const zipCode = typeof req.body.zipCode === 'string' || typeof req.body.zipCode === 'number' ? String(req.body.zipCode).trim() : '';
  const vehicleId = stringField(req.body.vehicleId, 'cvna-2286413');
  const termMonths = Number(req.body.termMonths);
  const creditTier = stringField(req.body.creditTier, 'excellent');
  const deliveryMethod = stringField(req.body.deliveryMethod, 'home_delivery');
  const protectionPlan = stringField(req.body.protectionPlan, 'none');
  const downPayment = nonNegativeInteger(req.body.downPayment, 0);
  const tradeInValue = nonNegativeInteger(req.body.tradeInValue, 0);

  if (!buyerName) {
    return res.status(400).json({ success: false, error: 'buyerName is required', code: 'VALIDATION_ERROR' });
  }
  if (!/^\d{5}$/.test(zipCode)) {
    return res.status(400).json({ success: false, error: 'zipCode must be a 5-digit US ZIP code', code: 'VALIDATION_ERROR' });
  }
  if (!has(INVENTORY, vehicleId)) {
    return res.status(400).json({ success: false, error: `Vehicle not in inventory: ${vehicleId}`, code: 'VALIDATION_ERROR' });
  }
  const vehicle = INVENTORY[vehicleId];
  if (!FINANCING_TERMS.includes(termMonths)) {
    return res.status(400).json({ success: false, error: `termMonths must be one of: ${FINANCING_TERMS.join(', ')}`, code: 'VALIDATION_ERROR' });
  }
  if (!has(CREDIT_TIERS, creditTier)) {
    return res.status(400).json({ success: false, error: `Unknown credit tier: ${creditTier}`, code: 'VALIDATION_ERROR' });
  }
  if (!has(DELIVERY_OPTIONS, deliveryMethod)) {
    return res.status(400).json({ success: false, error: `Unknown delivery method: ${deliveryMethod}`, code: 'VALIDATION_ERROR' });
  }
  if (!has(PROTECTION_PLANS, protectionPlan)) {
    return res.status(400).json({ success: false, error: `Unknown protection plan: ${protectionPlan}`, code: 'VALIDATION_ERROR' });
  }
  if (downPayment === null || tradeInValue === null) {
    return res.status(400).json({ success: false, error: 'downPayment and tradeInValue must be non-negative integers', code: 'VALIDATION_ERROR' });
  }
  if (downPayment + tradeInValue >= vehicle.price) {
    return res.status(400).json({ success: false, error: 'downPayment plus tradeInValue must be less than the vehicle price to finance', code: 'VALIDATION_ERROR' });
  }

  try {
    const result = await placeOrder({
      buyerName,
      zipCode,
      vehicleId,
      termMonths,
      creditTier,
      deliveryMethod,
      protectionPlan,
      downPayment,
      tradeInValue,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'ORDER_PLACEMENT_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
