const express = require('express');
const { createScoreCardStore } = require('../../services/verticals/1b17e823-loyalty/scorecard');

/**
 * Mock DICK'S ScoreCard loyalty API for the DICK'S x Foot Locker integration
 * demo. See app/services/verticals/1b17e823-loyalty/README.md.
 */
function createScoreCardRouter(store = createScoreCardStore()) {
  const router = express.Router();
  const base = '/api/1b17e823/scorecard';
  const err = (res, status, error, message) => res.status(status).json({ error, message });

  router.get(`${base}/members`, (req, res) => {
    const { email, phone } = req.query;
    if (!email && !phone) return err(res, 400, 'missing_query', 'Provide email and/or phone');
    return res.json({ members: store.findMembers({ email, phone }) });
  });

  router.get(`${base}/members/:id`, (req, res) => {
    const member = store.getMember(req.params.id);
    if (!member) return err(res, 404, 'member_not_found', `No ScoreCard member ${req.params.id}`);
    return res.json(member);
  });

  router.get(`${base}/members/:id/transactions`, (req, res) => {
    const rows = store.listTransactions(req.params.id);
    if (!rows) return err(res, 404, 'member_not_found', `No ScoreCard member ${req.params.id}`);
    return res.json({ transactions: rows });
  });

  router.post(`${base}/members/:id/earn`, (req, res) => {
    const { amount, order_id: orderId } = req.body || {};
    if (!store.getMember(req.params.id)) return err(res, 404, 'member_not_found', `No ScoreCard member ${req.params.id}`);
    if (typeof amount !== 'number' || amount <= 0 || !orderId) return err(res, 400, 'invalid_request', 'amount (> 0) and order_id are required');
    return res.status(201).json(store.earn(req.params.id, { amount, order_id: orderId }));
  });

  router.post(`${base}/members/:id/redeem`, (req, res) => {
    const { points, order_id: orderId } = req.body || {};
    if (!store.getMember(req.params.id)) return err(res, 404, 'member_not_found', `No ScoreCard member ${req.params.id}`);
    if (!Number.isInteger(points) || points <= 0 || !orderId) return err(res, 400, 'invalid_request', 'points (positive integer) and order_id are required');
    const result = store.redeem(req.params.id, { points, order_id: orderId });
    if (result.error) return err(res, 409, result.error, `Member has ${result.available} points`);
    return res.status(201).json(result);
  });

  return router;
}

module.exports = createScoreCardRouter();
module.exports.createScoreCardRouter = createScoreCardRouter;
