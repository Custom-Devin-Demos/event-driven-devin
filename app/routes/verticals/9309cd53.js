const express = require('express');
const { processDonation, APPEALS } = require('../../services/verticals/9309cd53');

const router = express.Router();

/**
 * GET /api/9309cd53/appeals — returns active humanitarian appeals
 */
router.get('/api/9309cd53/appeals', (_req, res) => {
  res.json({
    appeals: APPEALS.map((a) => ({
      id: a.id,
      name: a.name,
      region: a.region,
    })),
  });
});

/**
 * POST /api/9309cd53/donate — process a donation
 */
router.post('/api/9309cd53/donate', async (req, res) => {
  try {
    const result = await processDonation({
      appealId: req.body.appealId || 'where-needed',
      frequency: req.body.frequency || 'once',
      amount: Number(req.body.amount) || 70,
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
      code: error.code || 'DONATION_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
