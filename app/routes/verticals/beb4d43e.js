const express = require('express');
const { runInquiry, PROPERTIES, ROOM_CATALOG } = require('../../services/verticals/beb4d43e');

const router = express.Router();

/**
 * GET /api/beb4d43e/components — returns property and room data
 */
router.get('/api/beb4d43e/components', (_req, res) => {
  res.json({ properties: PROPERTIES, rooms: ROOM_CATALOG });
});

/**
 * POST /api/beb4d43e/inquiry — run a room availability inquiry
 */
router.post('/api/beb4d43e/inquiry', async (req, res) => {
  try {
    const result = await runInquiry({
      property: req.body.property || 'maui',
      roomType: req.body.roomType || 'suite',
      priority: req.body.priority || 'standard',
      sku: req.body.sku,
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
      code: error.code || 'INQUIRY_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
