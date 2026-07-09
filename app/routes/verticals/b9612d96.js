const express = require('express');
const { processDispatch, CATALOG } = require('../../services/verticals/b9612d96');

const router = express.Router();

/**
 * GET /api/b9612d96/catalog — returns available specialty-ingredient samples
 */
router.get('/api/b9612d96/catalog', (_req, res) => {
  res.json({ catalog: CATALOG });
});

/**
 * POST /api/b9612d96/dispatch — dispatch a specialty-ingredient sample order
 */
router.post('/api/b9612d96/dispatch', async (req, res) => {
  try {
    const result = await processDispatch({
      userId: req.body.userId || 'usr_croda_formulator',
      items: Array.isArray(req.body.items) ? req.body.items : [],
      subtotal: Number(req.body.subtotal) || 0,
      site: req.body.site || 'rawcliffe-bridge',
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
      code: error.code || 'DISPATCH_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
