const express = require('express');
const { payVendor, VENDORS, FUNDING_ACCOUNT } = require('../../services/verticals/4f9ede2a');

const router = express.Router();

/**
 * GET /api/4f9ede2a/vendors — vendors enrolled in business bill pay
 */
router.get('/api/4f9ede2a/vendors', (_req, res) => {
  res.json({ vendors: VENDORS, fundingAccount: FUNDING_ACCOUNT });
});

/**
 * POST /api/4f9ede2a/pay — pay a vendor's outstanding bills
 */
router.post('/api/4f9ede2a/pay', async (req, res) => {
  try {
    const confirmation = await payVendor({
      vendorId: req.body.vendorId,
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
      code: error.code || 'BILL_PAY_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
