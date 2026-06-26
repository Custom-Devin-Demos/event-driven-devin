const express = require('express');
const { processCardRequest, CARDS } = require('../../services/verticals/054f8313');

const router = express.Router();

/**
 * GET /api/054f8313/cards — returns available credit card products
 */
router.get('/api/054f8313/cards', (_req, res) => {
  res.json({
    cards: Object.entries(CARDS).map(([id, c]) => ({
      id,
      code: c.code,
      name: c.name,
      annualFee: c.annualFee,
    })),
  });
});

/**
 * POST /api/054f8313/apply — build a credit card offer
 */
router.post('/api/054f8313/apply', async (req, res) => {
  try {
    const result = await processCardRequest({
      card: req.body.card || 'clasica',
      term: req.body.term || 12,
      benefits: req.body.benefits || [],
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
      code: error.code || 'APPLICATION_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
