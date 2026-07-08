const express = require('express');
const { processOrder, CATALOG } = require('../../services/verticals/9309cd53');

const router = express.Router();

/**
 * GET /api/9309cd53/catalog — returns available relief supplies
 */
router.get('/api/9309cd53/catalog', (_req, res) => {
  res.json({ catalog: CATALOG });
});

/**
 * POST /api/9309cd53/checkout — dispatch a relief-supply order
 */
router.post('/api/9309cd53/checkout', async (req, res) => {
  try {
    const result = await processOrder({
      userId: req.body.userId || 'usr_icrc_field',
      items: Array.isArray(req.body.items) ? req.body.items : [],
      subtotal: Number(req.body.subtotal) || 0,
      zone: req.body.zone || 'gaza',
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'ORDER_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
