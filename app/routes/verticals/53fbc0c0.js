const express = require('express');
const { submitInquiry, PRODUCT_LINES, NETWORK_STATS } = require('../../services/verticals/53fbc0c0');

const router = express.Router();

/**
 * GET /api/53fbc0c0/product-lines — product lines offered on the contact form
 */
router.get('/api/53fbc0c0/product-lines', (_req, res) => {
  res.json({
    productLines: PRODUCT_LINES.map((line) => ({
      code: line.code,
      label: line.label,
    })),
  });
});

/**
 * GET /api/53fbc0c0/stats — dealer-network stats surfaced on the site
 */
router.get('/api/53fbc0c0/stats', (_req, res) => {
  res.json({ stats: NETWORK_STATS });
});

/**
 * POST /api/53fbc0c0/inquiry — submit a product inquiry
 */
router.post('/api/53fbc0c0/inquiry', async (req, res) => {
  try {
    const confirmation = await submitInquiry({
      productLine: req.body.productLine || 'combines',
      farmName: req.body.farmName || '',
      name: req.body.name || '',
      email: req.body.email || '',
      message: req.body.message || '',
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
      code: error.code || 'INQUIRY_ROUTING_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
