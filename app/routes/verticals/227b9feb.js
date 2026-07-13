const express = require('express');
const { processInquiry, MORTGAGE_PRODUCTS } = require('../../services/verticals/227b9feb');

const router = express.Router();

/**
 * GET /api/227b9feb/products — returns the mortgage product catalog
 */
router.get('/api/227b9feb/products', (_req, res) => {
  res.json({
    products: MORTGAGE_PRODUCTS.map((p) => ({
      id: p.id,
      label: p.label,
      terms: p.terms,
    })),
  });
});

/**
 * POST /api/227b9feb/inquiry — get a personalized mortgage pre-approval rate quote
 */
router.post('/api/227b9feb/inquiry', async (req, res) => {
  try {
    const result = await processInquiry({
      productId: req.body.productId || 'fixed-closed',
      term: req.body.term || 4,
      amount: req.body.amount || 550000,
      amortization: req.body.amortization || 25,
      creditTier: req.body.creditTier || 'good',
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
      code: error.code || 'PREAPPROVAL_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
