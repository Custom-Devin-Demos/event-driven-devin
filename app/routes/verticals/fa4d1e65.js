const express = require('express');
const { submitEngagement, PRACTICES } = require('../../services/verticals/fa4d1e65');

const router = express.Router();

/**
 * GET /api/fa4d1e65/practices — advisory practices available for inquiry
 */
router.get('/api/fa4d1e65/practices', (_req, res) => {
  res.json({
    practices: Object.values(PRACTICES).map((practice) => ({
      code: practice.code,
      name: practice.name,
      description: practice.description,
    })),
  });
});

/**
 * POST /api/fa4d1e65/engagement — submit an engagement inquiry
 */
router.post('/api/fa4d1e65/engagement', async (req, res) => {
  try {
    const brief = await submitEngagement({
      practice: req.body.practice || 'strategic_advisory',
      region: req.body.region || 'US',
      transactionValueUsd: req.body.transactionValueUsd,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(brief);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'ENGAGEMENT_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
