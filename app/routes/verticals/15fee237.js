const express = require('express');
const { refreshHoldings, POSITIONS } = require('../../services/verticals/15fee237');

const router = express.Router();

router.get('/api/15fee237/positions', (_req, res) => {
  res.json({ positions: POSITIONS });
});

router.post('/api/15fee237/refresh', async (req, res) => {
  try {
    const result = await refreshHoldings({
      accountId: req.body.accountId || 'MSSB-00000000',
      registration: req.body.registration || 'roth-ira',
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
      code: error.code || 'REFRESH_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
