const express = require('express');
const { calculateCopayBenefit, PRODUCTS, CARDHOLDERS } = require('../../services/verticals/1d54e3b4');

const router = express.Router();

router.get('/api/1d54e3b4/context', (_req, res) => {
  res.json({ products: PRODUCTS, cardholders: CARDHOLDERS });
});

router.post('/api/1d54e3b4/copay-benefit', async (req, res) => {
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
