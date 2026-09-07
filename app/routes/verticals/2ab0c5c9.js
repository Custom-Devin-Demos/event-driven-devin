const express = require('express');
const { openAccount, CHECKING_PRODUCTS } = require('../../services/verticals/2ab0c5c9');

const router = express.Router();

/**
 * GET /api/2ab0c5c9/products — checking products available to open
 */
router.get('/api/2ab0c5c9/products', (_req, res) => {
  res.json({ products: CHECKING_PRODUCTS });
});

/**
 * POST /api/2ab0c5c9/open-account — open a checking account
 */
router.post('/api/2ab0c5c9/open-account', async (req, res) => {
  try {
    const confirmation = await openAccount({
      productId: req.body.productId,
      openingDeposit: req.body.openingDeposit,
      zipCode: req.body.zipCode,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(confirmation);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'ACCOUNT_OPENING_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
