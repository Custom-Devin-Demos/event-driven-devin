const express = require('express');
const { searchProviders, getSearchCatalog } = require('../../services/verticals/a5bf9cf3');

const router = express.Router();

router.get('/api/a5bf9cf3/providers', (_req, res) => {
  res.json(getSearchCatalog());
});

router.post('/api/a5bf9cf3/providers/search', async (req, res) => {
  try {
    const result = await searchProviders({
      query: req.body.query,
      insurance: req.body.insurance,
      zip: req.body.zip,
      lat: req.body.lat,
      lng: req.body.lng,
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
      code: error.code || 'PROVIDER_SEARCH_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
