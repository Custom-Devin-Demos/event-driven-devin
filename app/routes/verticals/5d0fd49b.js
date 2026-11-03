const express = require('express');
const {
  quoteSweep,
  COLLECTIONS,
  SWEEP_SOURCES,
  ETH_USD,
  MAX_SWEEP_QUANTITY,
} = require('../../services/verticals/5d0fd49b');

const router = express.Router();

router.get('/api/5d0fd49b/collections', (_req, res) => {
  res.json({
    ethUsd: ETH_USD,
    maxQuantity: MAX_SWEEP_QUANTITY,
    collections: Object.entries(COLLECTIONS).map(([key, collection]) => ({
      key,
      label: collection.label,
      chain: collection.chain,
      floorEth: collection.floorEth,
    })),
    sourceOptions: Object.entries(SWEEP_SOURCES).map(([key, option]) => ({
      key,
      label: option.label,
      marketplaceCount: option.marketplaces.length,
    })),
  });
});

router.post('/api/5d0fd49b/sweep-quote', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await quoteSweep({
      collection: body.collection,
      quantity: body.quantity,
      source: body.source,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });

    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'SWEEP_QUOTE_FAILED',
      requestId: error.requestId || req.requestId || null,
    });
  }
});

module.exports = router;
