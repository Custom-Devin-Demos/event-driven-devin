const express = require('express');
const { checkAvailability, RESORTS } = require('../../services/verticals/35c30158');

const router = express.Router();

router.get('/api/35c30158/resorts', (req, res) => {
  res.json({ success: true, resorts: RESORTS });
});

router.post('/api/35c30158/availability', async (req, res) => {
  try {
    const availability = await checkAvailability({
      resort: req.body.resort,
      activity: req.body.activity,
      fulfillment: req.body.fulfillment,
      pickupDate: req.body.pickupDate,
      returnDate: req.body.returnDate,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json({ success: true, availability });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'AVAILABILITY_CHECK_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
