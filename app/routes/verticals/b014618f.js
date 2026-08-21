const express = require('express');
const { redeemMiles, CARD_PRODUCTS } = require('../../services/verticals/b014618f');

const router = express.Router();

/**
 * GET /api/b014618f/cards — rewards cards eligible for miles redemption
 */
router.get('/api/b014618f/cards', (_req, res) => {
  res.json({
    cards: CARD_PRODUCTS.map((card) => ({
      code: card.code,
      name: card.name,
      network: card.network,
      annualFee: card.annualFee,
    })),
  });
});

/**
 * POST /api/b014618f/redeem-miles — apply miles to a Capital One Travel booking
 */
router.post('/api/b014618f/redeem-miles', async (req, res) => {
  try {
    const result = await redeemMiles({
      cardProduct: req.body.cardProduct || 'venture-x',
      bookingType: req.body.bookingType || 'hotel',
      property: req.body.property,
      checkIn: req.body.checkIn,
      checkOut: req.body.checkOut,
      tripTotalUsd: req.body.tripTotalUsd,
      milesApplied: req.body.milesApplied,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'MILES_REDEMPTION_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
