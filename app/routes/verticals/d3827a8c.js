const express = require('express');
const {
  processFuelCheckout,
  resolveStation,
  resolveFleet,
  isKnownProduct,
  FUEL_PRODUCTS,
  STATIONS,
  FLEET_ACCOUNTS,
} = require('../../services/verticals/d3827a8c');

const router = express.Router();

const DEFAULT_ITEMS = [
  { sku: 'DSL-2-ULSD', qty: 150, price: 3.899 },
  { sku: 'DSL-RFR', qty: 40, price: 3.649 },
  { sku: 'DEF-BULK', qty: 5, price: 3.49 },
];

router.get('/api/d3827a8c/catalog', (_req, res) => {
  res.json({
    products: FUEL_PRODUCTS,
    stations: Object.values(STATIONS),
    fleets: Object.values(FLEET_ACCOUNTS),
  });
});

router.post('/api/d3827a8c/checkout', async (req, res) => {
  const body = req.body || {};
  const fleetId = typeof body.fleetId === 'string' ? body.fleetId.trim() : 'FLT-48213';
  const stationId = typeof body.stationId === 'string' ? body.stationId.trim() : 'TA-JOLIET-IL';
  const items = Array.isArray(body.items) ? body.items : DEFAULT_ITEMS;

  if (!resolveFleet(fleetId)) {
    return res.status(400).json({ success: false, error: `Unknown fleet account: ${fleetId}`, code: 'VALIDATION_ERROR' });
  }
  if (!resolveStation(stationId)) {
    return res.status(400).json({ success: false, error: `Unknown station: ${stationId}`, code: 'VALIDATION_ERROR' });
  }
  if (items.length === 0) {
    return res.status(400).json({ success: false, error: 'Add at least one product to authorize', code: 'EMPTY_CART' });
  }
  const invalid = items.find((item) => !item || !isKnownProduct(item.sku)
    || !(Number(item.qty) > 0) || !(Number(item.price) > 0));
  if (invalid) {
    return res.status(400).json({ success: false, error: `Invalid line item: ${JSON.stringify(invalid)}`, code: 'VALIDATION_ERROR' });
  }

  try {
    const result = await processFuelCheckout({
      fleetId,
      stationId,
      items: items.map((item) => ({ sku: item.sku, qty: Number(item.qty), price: Number(item.price) })),
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    return res.json(result);
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'FUEL_AUTHORIZATION_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
