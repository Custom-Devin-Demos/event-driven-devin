const express = require('express');
const { overview, resetClaims, processClaim } = require('../../services/verticals/188f0cf2');
const router = express.Router();
router.get('/api/188f0cf2/account', (_req, res) => res.json(overview()));
router.post('/api/188f0cf2/claims/reset', (_req, res) => res.json(resetClaims()));
router.post('/api/188f0cf2/claims', async (req, res) => {
  const data = req.body || {};
  if (!['Trash', 'Recycling', 'Yard waste'].includes(data.container) || !/^\d{4}-\d{2}-\d{2}$/.test(data.date || '')) {
    return res.status(400).json({ success: false, error: 'Choose a container and a valid pickup date.' });
  }
  try {
    res.json(await processClaim(data));
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message, errorClass: error.name, requestId: req.requestId });
  }
});
module.exports = router;
