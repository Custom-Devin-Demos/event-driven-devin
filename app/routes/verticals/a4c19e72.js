const express = require('express');
const { CATALOG, STORES, REVISION, quoteCart } = require('../../services/verticals/a4c19e72');
const { SESSION_URL, REPO, BASE_BRANCH } = require('../../services/verticals/a4c19e72-alert');
const router = express.Router();

router.get('/api/a4c19e72/catalog', (_req, res) => {
  res.json({ products: CATALOG, stores: STORES, revision: REVISION, liveTeams: process.env.LOWES_DEMO_LIVE_TEAMS === 'true', sessionUrl: SESSION_URL, sourceUrl: `${REPO}/tree/${BASE_BRANCH}`, fixUrl: process.env.LOWES_DEMO_FIX_PR_URL || null });
});

router.post('/api/a4c19e72/checkout', (req, res) => {
  try { res.json(quoteCart(req.body)); }
  catch (error) {
    res.status(error.status || 500).json({ success: false, demo: true, code: error.status === 400 ? 'INVALID_CART' : 'PICKUP_QUOTE_FAILED', error: error.status === 400 ? error.message : 'We couldn’t prepare your pickup checkout. Your cart is saved.', diagnostic: error.message });
  }
});

module.exports = router;
