const express = require('express');
const { getRetailerOffers, CATALOG, RETAILERS } = require('../../services/verticals/7019ea46');

const router = express.Router();

router.get('/api/7019ea46/catalog', (_req, res) => {
  res.json({
    products: CATALOG,
    retailers: RETAILERS.map(({ id, name, logo }) => ({ id, name, logo })),
  });
});

router.post('/api/7019ea46/buy-now', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await getRetailerOffers({
      ean: body.ean,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'BUY_NOW_FAILED',
      requestId: req.requestId,
      newRelic: error.newRelic,
    });
  }
});

module.exports = router;
