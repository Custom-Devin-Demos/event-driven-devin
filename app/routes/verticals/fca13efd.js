const express = require('express');
const { PROGRAMS, PLATFORMS, REGIONS, submitPlaytestSignup } = require('../../services/verticals/fca13efd');
const router = express.Router();

router.get('/api/fca13efd/catalog', (_req, res) => res.json({ programs: PROGRAMS, platforms: PLATFORMS, regions: REGIONS }));

router.post('/api/fca13efd/playtest-signups', async (req, res) => {
  const body = req.body || {};
  try {
    res.json(await submitPlaytestSignup({
      signup: body.signup,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    }));
  } catch (error) {
    res.status(error.status || 500).json({
      success: false, error: error.message, errorClass: error.name,
      code: error.code || 'PLAYTEST_SIGNUP_FAILED', requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;
