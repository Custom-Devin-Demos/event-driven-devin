const express = require('express');
const { redeemPoints } = require('../../services/verticals/bonvoy');

const router = express.Router();

/**
 * POST /api/bonvoy/points/redeem — redeem Marriott Bonvoy points for a stay.
 *
 * Called by the Bonvoy Android app (neil-z-kelly/bonvoy-android); there is no
 * web page for this vertical.
 */
router.post('/api/bonvoy/points/redeem', async (req, res) => {
  try {
    const result = await redeemPoints({
      memberNumber: req.body.member_number || req.body.memberNumber,
      hotel: req.body.hotel,
      nights: req.body.nights,
      points: req.body.points,
      client: req.get('X-Bonvoy-Client'),
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.name || 'Error',
      message: error.message,
      code: error.code || 'POINTS_REDEMPTION_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
