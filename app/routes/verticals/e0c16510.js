const express = require('express');
const { processContactSales, PLAN_TIERS, REGION_MULTIPLIERS } = require('../../services/verticals/e0c16510');

const router = express.Router();

/**
 * GET /api/e0c16510/plans — returns available plans and regions
 */
router.get('/api/e0c16510/plans', (_req, res) => {
  const plans = Object.entries(PLAN_TIERS).map(([id, tier]) => ({
    id,
    label: tier.label,
    pricePerSeat: tier.pricePerSeat,
    features: tier.features,
  }));
  res.json({ plans, regions: Object.keys(REGION_MULTIPLIERS) });
});

/**
 * POST /api/e0c16510/contact-sales — process a contact sales inquiry
 */
router.post('/api/e0c16510/contact-sales', async (req, res) => {
  try {
    const { firstName, lastName, jobTitle, email, company, plan, seats, region, compliance } = req.body;

    const result = await processContactSales({
      firstName: firstName || '',
      lastName: lastName || '',
      jobTitle: jobTitle || '',
      email,
      company,
      plan: normalizePlanId(plan || 'enterprise'),
      seats: parseInt(seats, 10) || 50,
      region: region || 'ap-northeast-1',
      compliance: sanitizeComplianceCodes(compliance),
      devinEmail: req.body.devinEmail,
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: error.message,
      errorClass: error.name,
      code: error.code || 'CONTACT_SALES_FAILED',
      requestId: req.requestId,
    });
  }
});

function normalizePlanId(planId) {
  return planId.trim().toLowerCase();
}

function sanitizeComplianceCodes(codes) {
  if (!codes) return ['SOC2', 'ISO27001', 'ISMAP'];
  if (Array.isArray(codes)) return codes;
  return String(codes).split(',').map((c) => c.trim());
}

module.exports = router;
