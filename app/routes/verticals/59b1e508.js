const express = require('express');
const {
  SERVICE_AREAS,
  sanitizeLookupInput,
} = require('../../services/verticals/59b1e508-address-index');
const { lookupServiceSchedule } = require('../../services/verticals/59b1e508');

const router = express.Router();

router.get('/api/59b1e508/service-areas', (_req, res) => {
  res.json({ serviceAreas: SERVICE_AREAS });
});

router.post('/api/59b1e508/schedule-lookup', async (req, res) => {
  try {
    const result = await lookupServiceSchedule(sanitizeLookupInput(req.body));
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: 'INTERNAL_ERROR',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
