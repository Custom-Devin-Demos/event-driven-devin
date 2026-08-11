const express = require('express');
const {
  scopeEngagement,
  CAPABILITIES,
  DELIVERY_REGIONS,
  SQUAD_ROLES,
} = require('../../services/verticals/90a02f02');

const router = express.Router();

router.get('/api/90a02f02/solutions', (_req, res) => {
  res.json({ capabilities: CAPABILITIES, deliveryRegions: DELIVERY_REGIONS, squadRoles: SQUAD_ROLES });
});

router.post('/api/90a02f02/inquiry', async (req, res) => {
  try {
    const result = await scopeEngagement({
      capability: req.body.capability || 'Enterprise GenAI Strategy',
      deliveryRegion: req.body.deliveryRegion || 'São Paulo',
      company: req.body.company || 'Global enterprise',
      message: req.body.message || 'We would like to discuss a transformation engagement.',
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
