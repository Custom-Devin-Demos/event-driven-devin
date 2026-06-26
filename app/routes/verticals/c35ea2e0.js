const express = require('express');
const { processQuoteRequest, EQUIPMENT } = require('../../services/verticals/c35ea2e0');

const router = express.Router();

/**
 * GET /api/c35ea2e0/equipment — returns available equipment lines
 */
router.get('/api/c35ea2e0/equipment', (_req, res) => {
  res.json({
    equipment: Object.entries(EQUIPMENT).map(([id, e]) => ({
      id,
      code: e.code,
      name: e.name,
      listPrice: e.listPrice,
      term: e.term,
    })),
  });
});

/**
 * POST /api/c35ea2e0/quote — build an equipment quote
 */
router.post('/api/c35ea2e0/quote', async (req, res) => {
  try {
    const result = await processQuoteRequest({
      equipment: req.body.equipment || 'aerial',
      term: req.body.term || 48,
      support: req.body.support || [],
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
      code: error.code || 'QUOTE_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
