const express = require('express');
const { checkoutBeat, BEATS } = require('../../services/verticals/b47d51c2');

const router = express.Router();

/**
 * GET /api/b47d51c2/beats — the beat catalog
 */
router.get('/api/b47d51c2/beats', (_req, res) => {
  res.json({ beats: BEATS });
});

/**
 * POST /api/b47d51c2/checkout — purchase a beat license
 */
router.post('/api/b47d51c2/checkout', async (req, res) => {
  try {
    const confirmation = await checkoutBeat({
      beatId: req.body.beatId || '',
      tier: req.body.tier || 'basic',
      buyerName: req.body.buyerName || '',
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
      code: error.code || 'BEAT_CHECKOUT_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
