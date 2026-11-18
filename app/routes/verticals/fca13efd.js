const express = require('express');
const { EVENT, PLATFORMS, REGIONS, submitHuntRegistration } = require('../../services/verticals/fca13efd');
const router = express.Router();

router.get('/api/fca13efd/catalog', (_req, res) => res.json({ event: EVENT, platforms: PLATFORMS, regions: REGIONS }));

router.post('/api/fca13efd/hunt-registrations', async (req, res) => {
  const body = req.body || {};
  try {
    res.json(await submitHuntRegistration({
      registration: body.registration,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    }));
  } catch (error) {
    res.status(error.status || 500).json({
      success: false, error: error.message, errorClass: error.name,
      code: error.code || 'HUNT_REGISTRATION_FAILED', requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;
