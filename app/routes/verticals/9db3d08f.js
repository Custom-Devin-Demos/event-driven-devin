const express = require('express');
const path = require('path');
const { filterClaims } = require('../../services/verticals/9db3d08f');

const router = express.Router();

router.get('/9db3d08f', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', '9db3d08f.html'));
});

router.post('/api/9db3d08f/filter', async (req, res) => {
  try {
    const result = await filterClaims(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'CLAIMS_FILTER_FAILED',
    });
  }
});

module.exports = router;
