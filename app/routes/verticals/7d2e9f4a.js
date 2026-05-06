const express = require('express');
const router = express.Router();
const { processClaimLookup, CLAIMS, RECENT_CLAIMS } = require('../../services/verticals/7d2e9f4a');

router.get('/api/7d2e9f4a/accounts', (_req, res) => {
  res.json({
    claims: CLAIMS.map((c) => ({
      claimNumber: c.claimNumber,
      provider: c.provider,
      status: c.status,
    })),
    recentClaims: RECENT_CLAIMS,
  });
});

router.post('/api/7d2e9f4a/claim', async (req, res) => {
  try {
    const result = await processClaimLookup(req.body);
    res.json(result);
  } catch (error) {
    res.status(error.code === 'CLAIM_NOT_FOUND' ? 404 : 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
    });
  }
});

module.exports = router;
