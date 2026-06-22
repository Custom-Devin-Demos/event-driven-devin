const express = require('express');
const { processSupplyInquiry, COMPANIES } = require('../../services/verticals/08381313');

const router = express.Router();

/**
 * GET /api/08381313/companies — returns available Koch companies
 */
router.get('/api/08381313/companies', (_req, res) => {
  res.json({
    companies: COMPANIES.map((c) => ({
      id: c.id,
      name: c.name,
      sector: c.sector,
      region: c.region,
    })),
  });
});

/**
 * POST /api/08381313/supply-inquiry — process a supply chain inquiry
 */
router.post('/api/08381313/supply-inquiry', async (req, res) => {
  try {
    const result = await processSupplyInquiry({
      companyId: req.body.companyId || 'KII-9204715',
      inquiryType: req.body.inquiryType || 'supply_chain_review',
      sector: req.body.sector || 'agriculture',
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
      code: error.code || 'SUPPLY_INQUIRY_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
