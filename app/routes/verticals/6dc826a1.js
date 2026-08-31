const express = require('express');
const {
  submitOrder,
  CLIENT_ACCOUNTS,
  INSTRUMENTS,
  ORDER_TYPES,
} = require('../../services/verticals/6dc826a1');

const router = express.Router();

router.get('/api/6dc826a1/book', (_req, res) => {
  res.json({
    accounts: Object.values(CLIENT_ACCOUNTS).map((account) => ({
      accountNumber: account.accountNumber,
      clientName: account.clientName,
      advisor: account.advisor,
      branch: account.branch,
      programLabel: account.programLabel,
      cashAvailable: account.cashAvailable,
      marketValue: account.marketValue,
    })),
    instruments: Object.values(INSTRUMENTS),
    orderTypes: Object.values(ORDER_TYPES).map((orderType) => ({
      code: orderType.code,
      label: orderType.label,
      requiresLimitPrice: orderType.requiresLimitPrice,
    })),
  });
});

router.post('/api/6dc826a1/order', async (req, res) => {
  const body = req.body || {};
  const valueOrDefault = (key, fallback) => (
    Object.prototype.hasOwnProperty.call(body, key) ? body[key] : fallback
  );

  try {
    const order = await submitOrder({
      accountNumber: valueOrDefault('accountNumber', 'WM-4417-20913'),
      symbol: valueOrDefault('symbol', 'AAPL'),
      side: valueOrDefault('side', 'buy'),
      quantity: valueOrDefault('quantity', 2500),
      orderType: valueOrDefault('orderType', 'advisory_wrap'),
      limitPrice: valueOrDefault('limitPrice', null),
      timeInForce: valueOrDefault('timeInForce', 'day'),
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(order);
  } catch (error) {
    if (error.statusCode === 400 || error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: error.message,
        errorClass: error.name,
        code: error.code || 'INVALID_ORDER',
        requestId: req.requestId,
      });
    }

    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'ORDER_BOOKING_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
