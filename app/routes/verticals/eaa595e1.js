const express = require('express');
const { placeOrder, rankOffers, CATALOG } = require('../../services/verticals/eaa595e1');
const logger = require('../../telemetry/logger');
const { Sentry } = require('../../telemetry/sentry');

const router = express.Router();

router.get('/api/eaa595e1/catalog', (_req, res) => {
  res.json({ products: CATALOG });
});

router.get('/api/eaa595e1/offers', (req, res) => {
  // Express yields an array for a repeated query param; rank against the last one.
  const requested = req.query.membership;
  const membership = Array.isArray(requested) ? requested[requested.length - 1] : requested;

  try {
    res.json(rankOffers(membership || 'boost-annual'));
  } catch (error) {
    // Only reachable if the materialized feature view is malformed. That is the one
    // failure this vertical must not degrade silently, so it goes to telemetry like
    // every other error path here rather than dying as a bare 500.
    logger.error('Kroger offer ranking failed', {
      error: error.message,
      errorClass: error.name,
      membership,
      service: 'kroger-ecommerce',
      route: '/api/eaa595e1/offers',
      requestId: req.requestId,
    });
    Sentry.captureException(error);

    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'OFFERS_FAILED',
      requestId: req.requestId,
    });
  }
});

router.post('/api/eaa595e1/order', async (req, res) => {
  try {
    const result = await placeOrder({
      customerId: req.body.customerId || 'anonymous',
      storeId: req.body.storeId || 'STORE-01400',
      items: req.body.items || [{ sku: 'KRO-ST-MILK', qty: 1, price: 5.49 }],
      subtotal: req.body.subtotal || 5.49,
      state: req.body.state || 'OH',
      fulfillmentMethod: req.body.fulfillmentMethod || 'delivery',
      membership: req.body.membership || 'boost-annual',
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
      code: error.code || 'ORDER_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
