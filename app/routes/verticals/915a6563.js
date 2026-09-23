const express = require('express');
const { submitPowerInquiry } = require('../../services/verticals/915a6563');

const router = express.Router();

router.post('/api/915a6563/power-inquiry', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await submitPowerInquiry({
      workEmail: body.workEmail,
      firstName: body.firstName,
      lastName: body.lastName,
      company: body.company,
      market: body.market,
      capacityNeed: body.capacityNeed,
      projectCountry: body.projectCountry,
      projectState: body.projectState,
      timeline: body.timeline,
      message: body.message,
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
      code: error.code || 'POWER_INQUIRY_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
