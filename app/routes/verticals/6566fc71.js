const express = require('express');
const { checkout, publicCatalog } = require('../../services/verticals/6566fc71');
const router = express.Router();

router.get('/api/6566fc71/catalog', (_req, res) => res.json(publicCatalog()));

router.post('/api/6566fc71/checkout', async (req, res) => {
  const body = req.body ?? {};
  try {
    res.json(await checkout({
      order: body.order,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    }));
  } catch (error) {
    res.status(error.status || 500).json({
      success: false, error: error.message, errorClass: error.name,
      code: error.code || 'CHECKOUT_FAILED', requestId: req.requestId,
    });
  }
});

module.exports = router;
