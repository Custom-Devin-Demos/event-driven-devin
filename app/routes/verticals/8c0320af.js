const express = require('express');
const {
  STUDIO, TRIMS, INVENTORY, PROGRAMS, FEES, findTrim, buildPaymentOptions, createQuote,
} = require('../../services/verticals/8c0320af');
const { placeOrder, resetOrders, currentStatus } = require('../../services/verticals/8c0320af-orders');

const router = express.Router();

function sendError(res, req, error, fallbackCode) {
  res.status(error.status || 500).json({
    success: false,
    error: error.message,
    errorClass: error.name,
    code: error.code || fallbackCode,
    requestId: req.requestId,
  });
}

/**
 * GET /api/8c0320af/catalog — trims, in-stock inventory, payment programs and fees
 */
router.get('/api/8c0320af/catalog', (_req, res) => {
  res.json({
    studio: STUDIO,
    trims: TRIMS,
    inventory: INVENTORY.map((vehicle) => {
      const trim = findTrim(vehicle.trim);
      const optionsTotal = vehicle.options.reduce((sum, o) => sum + o.price, 0);
      return {
        ...vehicle,
        trimName: trim.name,
        modelYear: trim.modelYear,
        range: trim.range,
        power: trim.power,
        zeroToSixty: trim.zeroToSixty,
        drivetrain: trim.drivetrain,
        listPrice: trim.basePrice + optionsTotal,
        sellingPrice: trim.basePrice + optionsTotal - (vehicle.inventoryDiscount || 0),
        paymentOptions: buildPaymentOptions(vehicle, trim),
      };
    }),
    programs: PROGRAMS.map(({ monthlyPayment, ...program }) => program),
    fees: FEES,
    status: currentStatus(),
  });
});

/**
 * POST /api/8c0320af/quotes — price a specific unit under a payment program
 */
router.post('/api/8c0320af/quotes', async (req, res) => {
  const body = req.body || {};
  if (!body.vin || !body.program) {
    return res.status(400).json({ success: false, error: 'vin and program are required', code: 'INVALID_REQUEST' });
  }
  try {
    const quote = await createQuote({
      vin: body.vin,
      program: body.program,
      deliveryState: body.deliveryState,
      loyalty: body.loyalty,
      conquest: body.conquest,
    });
    return res.json(quote);
  } catch (error) {
    return sendError(res, req, error, 'QUOTE_FAILED');
  }
});

/**
 * POST /api/8c0320af/orders — place the order against an issued quote
 */
router.post('/api/8c0320af/orders', async (req, res) => {
  const body = req.body || {};
  if (!body.quoteId) {
    return res.status(400).json({ success: false, error: 'quoteId is required', code: 'INVALID_REQUEST' });
  }
  try {
    const order = await placeOrder({
      quoteId: body.quoteId,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    return res.json(order);
  } catch (error) {
    return sendError(res, req, error, 'ORDER_FAILED');
  }
});

/**
 * POST /api/8c0320af/orders/reset — clear in-memory orders, quotes and mismatch history
 */
router.post('/api/8c0320af/orders/reset', (_req, res) => {
  res.json(resetOrders());
});

module.exports = router;
