const express = require('express');
const path = require('path');
const { filterAgents } = require('../../services/verticals/3d2ef497');

const router = express.Router();

router.get('/3d2ef497', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', '3d2ef497.html'));
});

router.post('/api/3d2ef497/filter-agents', async (req, res) => {
  try {
    const result = await filterAgents(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'CATALOG_FILTER_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
