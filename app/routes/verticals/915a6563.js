const express = require('express');
const { submitPowerInquiry } = require('../../services/verticals/915a6563');

const router = express.Router();

router.post('/api/915a6563/power-inquiry', async (req, res) => {
  try {
    const result = await submitPowerInquiry({
      workEmail: req.body.workEmail,
      firstName: req.body.firstName,
      lastName: req.body.lastName,
      company: req.body.company,
      market: req.body.market,
      capacityNeed: req.body.capacityNeed,
      projectCountry: req.body.projectCountry,
      projectState: req.body.projectState,
      timeline: req.body.timeline,
      message: req.body.message,
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
      code: error.code || 'POWER_INQUIRY_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
