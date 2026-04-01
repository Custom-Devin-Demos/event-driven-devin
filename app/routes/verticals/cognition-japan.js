const express = require('express');
const { processContactSales, RECENT_INQUIRIES, PLAN_CONFIGS } = require('../../services/verticals/cognition-japan');

const router = express.Router();

/**
 * GET /api/cognition-japan/plans — returns available plans and recent inquiries
 */
router.get('/api/cognition-japan/plans', (_req, res) => {
  const plans = Object.entries(PLAN_CONFIGS).map(([name, config]) => ({
    name,
    nameJa: config.nameJa,
    seats: config.seats,
    pricePerSeat: config.pricePerSeat,
    currency: config.currency,
    features: config.features,
    slaHours: config.slaHours,
  }));
  res.json({
    plans,
    recentInquiries: RECENT_INQUIRIES,
  });
});

/**
 * POST /api/cognition-japan/contact-sales — process a contact-sales inquiry
 */
router.post('/api/cognition-japan/contact-sales', async (req, res) => {
  try {
    const result = await processContactSales({
      company: req.body.company || '株式会社サンプル',
      contact: req.body.contact || '山田太郎',
      email: req.body.email || 'sample@example.co.jp',
      planId: (req.body.planId || 'Enterprise').trim(),
      seats: parseInt(req.body.seats, 10) || 100,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'CONTACT_SALES_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
