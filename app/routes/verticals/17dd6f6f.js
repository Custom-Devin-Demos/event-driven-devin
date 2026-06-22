const express = require('express');
const { processTrackShipment, SHIPMENTS } = require('../../services/verticals/17dd6f6f');

const router = express.Router();

/**
 * GET /api/17dd6f6f/shipments — returns the active shipments
 */
router.get('/api/17dd6f6f/shipments', (_req, res) => {
  res.json({
    shipments: SHIPMENTS.map((s) => ({
      trackingNumber: s.trackingNumber,
      serviceType: s.serviceType,
      destination: `${s.destination.city}, ${s.destination.state}`,
    })),
  });
});

/**
 * POST /api/17dd6f6f/track-shipment — build the tracking summary for a shipment
 */
router.post('/api/17dd6f6f/track-shipment', async (req, res) => {
  try {
    const result = await processTrackShipment({
      trackingNumber: req.body.trackingNumber || 'FX-7829104563',
      serviceType: req.body.serviceType || 'priority_overnight',
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
      code: error.code || 'TRACK_SHIPMENT_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
