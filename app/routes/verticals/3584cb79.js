const express = require('express');
const { processCheckout, CATALOG, TAX_REGIONS } = require('../../services/verticals/3584cb79');

const router = express.Router();

router.get('/api/3584cb79/catalog', (_req, res) => {
  res.json({ products: CATALOG });
});

router.post('/api/3584cb79/checkout', async (req, res) => {
  const region = req.body.region || 'MI';
  if (!Object.prototype.hasOwnProperty.call(TAX_REGIONS, region)) {
    return res.status(400).json({
      success: false,
      error: `Unknown pickup region: ${region}`,
      errorClass: 'ValidationError',
      code: 'INVALID_REGION',
      requestId: req.requestId,
    });
  }
  try {
    const result = await processCheckout({
      userId: req.body.userId || 'anonymous',
      items: req.body.items || [{ sku: 'LC-HNR-PEP', qty: 1, price: 7.49 }],
      subtotal: req.body.subtotal || 7.49,
      region,
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
      code: error.code || 'CHECKOUT_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
