const express = require('express');
const { calculateCopayBenefit, PRODUCTS, CARDHOLDERS } = require('../../services/verticals/46ce04a1');

const router = express.Router();

router.get('/api/46ce04a1/context', (_req, res) => {
  res.json({ products: PRODUCTS, cardholders: CARDHOLDERS });
});

router.post('/api/46ce04a1/copay-benefit', async (req, res) => {
  try {
    res.json(await calculateCopayBenefit(req.body || {}));
  } catch (error) {
    res.status(error.name === 'ValidationError' ? 400 : 500).json({
      success: false, error: error.message, errorClass: error.name,
      code: error.name === 'ValidationError' ? 'INVALID_REQUEST' : 'COPAY_BENEFIT_FAILED', requestId: req.requestId,
    });
  }
});

module.exports = router;
