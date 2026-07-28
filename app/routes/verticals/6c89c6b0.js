const express = require('express');
const path = require('path');
const { filterResources } = require('../../services/verticals/6c89c6b0');

const router = express.Router();

router.get('/6c89c6b0', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', '6c89c6b0.html'));
});

router.post('/api/6c89c6b0/filter', async (req, res) => {
  try {
    const result = await filterResources(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'RESOURCE_FILTER_FAILED',
    });
  }
});

module.exports = router;
