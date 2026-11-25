const path = require('path');
const express = require('express');
const svc = require('../../services/verticals/72a86265');

const router = express.Router();
const ASSETS = path.join(__dirname, '..', '..', 'public', 'verticals', '72a86265-assets');

const token = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
const send = (fn) => (req, res) => {
  try {
    res.status(req.method === 'POST' && req.path.endsWith('/transfers') ? 201 : 200).json(fn(req));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.code || 'transfer_failed', message: error.message, requestId: req.requestId });
  }
};

router.get(['/ciaran-bofa/campaign', '/72a86265/campaign'], (_req, res) => res.sendFile(path.join(ASSETS, 'campaign.html')));
router.post('/api/72a86265/session', (_req, res) => res.json(svc.openSession()));
router.get('/api/72a86265/accounts', send((req) => svc.accounts(token(req))));
router.get('/api/72a86265/transactions', send((req) => svc.transactions(token(req), req.query.accountId)));
router.post('/api/72a86265/transfers', send((req) => svc.transfer(token(req), req.body, {
  reportsOff: req.headers['x-demo-alerts'] === 'off',
  synthetic: Boolean(req.headers['x-synthetic']) && process.env.NODE_ENV !== 'production',
})));

module.exports = router;
