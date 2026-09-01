const express = require('express');
const { placeOrder, CATALOG } = require('../../services/verticals/4c351052');

const router = express.Router();

/**
 * GET /api/4c351052/catalog — deli items available in the pickup checkout
 */
router.get('/api/4c351052/catalog', (_req, res) => {
  res.json({
    items: Object.values(CATALOG).map((item) => ({
      sku: item.sku,
      name: item.name,
      department: item.department,
      price: item.price,
    })),
  });
});

/**
 * POST /api/4c351052/place-order — place an online pickup order
 */
router.post('/api/4c351052/place-order', async (req, res) => {
  try {
    const confirmation = await placeOrder({
      storeNumber: req.body.storeNumber || 1248,
      items: req.body.items || [{ sku: 'DELI-CTS-W', quantity: 1 }],
      firstName: req.body.firstName || 'John',
      lastName: req.body.lastName || 'Doe',
      email: req.body.email,
      phone: req.body.phone,
      pickupDate: req.body.pickupDate || 'Wednesday, September 2',
      pickupTime: req.body.pickupTime || '8:30 am',
      paymentMethod: req.body.paymentMethod || 'pay-in-store',
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(confirmation);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'PICKUP_ORDER_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
