const express = require('express');
const { submitOrder, ORDER_LINES } = require('../../services/verticals/86596b62');

const router = express.Router();

/**
 * GET /api/86596b62/order-lines — lines available on the order review page
 */
router.get('/api/86596b62/order-lines', (_req, res) => {
  res.json({
    orderLines: ORDER_LINES.map((line) => ({
      code: line.code,
      name: line.name,
      identifier: line.identifier,
      quantity: line.quantity,
      unitOfMeasure: line.unitOfMeasure,
      extendedPriceUsd: line.extendedPriceUsd,
    })),
  });
});

/**
 * POST /api/86596b62/submit-order — submit a Cardinal Health Market order
 */
router.post('/api/86596b62/submit-order', async (req, res) => {
  try {
    const result = await submitOrder({
      orderLine: req.body.orderLine || 'vaccine-refrigerated',
      contract: req.body.contract || 'novaplus',
      accountNumber: req.body.accountNumber,
      purchaseOrder: req.body.purchaseOrder,
      requestedDelivery: req.body.requestedDelivery,
      shipToName: req.body.shipToName,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'ORDER_SUBMISSION_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
