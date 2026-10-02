const express = require('express');
const {
  bookOrderLine,
  AD_ORDERS,
  INVENTORY_SLOTS,
  PROGRAMS,
} = require('../../services/verticals/2cd6eb18');

const router = express.Router();

router.get('/api/2cd6eb18/ad-orders', (_req, res) => {
  res.json({
    orders: Object.entries(AD_ORDERS).map(([orderNumber, o]) => ({ orderNumber, ...o })),
    slots: Object.entries(INVENTORY_SLOTS).map(([slotName, s]) => ({
      slotName,
      ...s,
      genre: PROGRAMS[s.program].genre,
      unitsRemaining: s.unitsAvailable - s.unitsSold,
    })),
  });
});

function has(map, key) {
  return typeof key === 'string' && Object.hasOwn(map, key);
}

function toNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

router.post('/api/2cd6eb18/order-lines', async (req, res) => {
  const orderNumber = typeof req.body.orderNumber === 'string' ? req.body.orderNumber : 'AO-000010';
  const slotName = typeof req.body.slotName === 'string' ? req.body.slotName : 'INV-00011';
  const units = toNumber(req.body.units, 4);
  const discountPct = toNumber(req.body.discountPct, 0);

  if (!has(AD_ORDERS, orderNumber)) {
    return res.status(400).json({ success: false, error: `Ad Order not found: ${orderNumber}`, code: 'VALIDATION_ERROR' });
  }
  if (!has(INVENTORY_SLOTS, slotName)) {
    return res.status(400).json({ success: false, error: `Inventory Slot not found: ${slotName}`, code: 'VALIDATION_ERROR' });
  }
  const slot = INVENTORY_SLOTS[slotName];
  const remaining = slot.unitsAvailable - slot.unitsSold;
  if (!Number.isSafeInteger(units) || units < 1 || units > remaining) {
    return res.status(400).json({ success: false, error: `Units must be a whole number between 1 and ${remaining} for ${slotName}`, code: 'VALIDATION_ERROR' });
  }
  if (!Number.isFinite(discountPct) || discountPct < 0 || discountPct > 100) {
    return res.status(400).json({ success: false, error: 'Discount % must be between 0 and 100', code: 'VALIDATION_ERROR' });
  }

  try {
    const result = await bookOrderLine({
      orderNumber,
      slotName,
      units,
      discountPct,
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
      code: error.code || 'ORDER_LINE_BOOKING_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
