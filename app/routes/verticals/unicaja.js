const express = require('express');
const {
  registerDigitalAccess,
  CUSTOMER_PROFILES,
  ACCESS_CHANNELS,
} = require('../../services/verticals/unicaja');

const router = express.Router();

router.get('/api/unicaja/mock-data', (_req, res) => {
  res.json({
    profiles: CUSTOMER_PROFILES,
    channels: ACCESS_CHANNELS,
  });
});

router.post('/api/unicaja/registration', async (req, res) => {
  try {
    const result = await registerDigitalAccess({
      profileId: req.body.profileId,
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
      code: error.code || 'DIGITAL_ENROLLMENT_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
