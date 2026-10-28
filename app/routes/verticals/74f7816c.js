const express = require('express');
const { listLooks, addLookToBag, checkout } = require('../../services/verticals/74f7816c');

const router = express.Router();

function sendError(req, res, error, fallbackCode) {
  return res.status(error.statusCode || 500).json({
    success: false,
    error: error.message,
    errorClass: error.name,
    code: error.code || fallbackCode,
    unavailable: error.unavailable,
    requestId: req.requestId,
  });
}

router.get('/api/74f7816c/looks', (_req, res) => {
  res.json(listLooks());
});

router.post('/api/74f7816c/bag/items', (req, res) => {
  try {
    const body = req.body || {};
    return res.json(addLookToBag({ cartId: body.cartId, lookId: body.lookId }));
  } catch (error) {
    return sendError(req, res, error, 'ADD_TO_BAG_FAILED');
  }
});

router.post('/api/74f7816c/checkout', async (req, res) => {
  try {
    const body = req.body || {};
    const result = await checkout({
      cartId: body.cartId,
      lines: body.lines,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    return res.json(result);
  } catch (error) {
    return sendError(req, res, error, 'CHECKOUT_FAILED');
  }
});

module.exports = router;
