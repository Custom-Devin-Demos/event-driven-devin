const express = require('express');
const {
  runAccountingSync,
  CARDS,
  CARD_SCOPES,
  DESTINATIONS,
} = require('../../services/verticals/e9838029');

const router = express.Router();

router.get('/api/e9838029/cards', (req, res) => {
  res.json({
    cards: Object.entries(CARDS).map(([key, card]) => ({
      key,
      cardholder: card.cardholder,
      role: card.role,
      last4: card.last4,
      type: card.type,
      monthlyLimitCents: card.monthlyLimitCents,
    })),
    scopeOptions: Object.entries(CARD_SCOPES).map(([key, option]) => ({
      key,
      label: option.label,
      cardCount: option.cards.length,
    })),
    destinations: Object.entries(DESTINATIONS).map(([key, destination]) => ({
      key,
      label: destination.label,
    })),
  });
});

router.post('/api/e9838029/accounting-sync', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await runAccountingSync({
      business: body.business,
      destination: body.destination,
      scope: body.scope,
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
      code: error.code || 'ACCOUNTING_SYNC_FAILED',
      requestId: error.requestId || req.requestId || null,
    });
  }
});

module.exports = router;
