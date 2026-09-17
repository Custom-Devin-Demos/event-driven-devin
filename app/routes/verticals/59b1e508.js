const express = require('express');
const {
  SERVICE_AREAS,
  parseAddress,
  sanitizeLookupInput,
} = require('../../services/verticals/59b1e508-address-index');
const { lookupServiceSchedule } = require('../../services/verticals/59b1e508');

const router = express.Router();
const SERVICE_ZIPS = new Set(SERVICE_AREAS.map((area) => area.zip));

router.get('/api/59b1e508/service-areas', (_req, res) => {
  res.json({ serviceAreas: SERVICE_AREAS });
});

router.post('/api/59b1e508/schedule-lookup', async (req, res) => {
  try {
    const sanitizedInput = sanitizeLookupInput(req.body);
    let lookupInput = sanitizedInput;
    try {
      const parsed = parseAddress(sanitizedInput.address);
      if (!SERVICE_ZIPS.has(parsed.zip)) lookupInput = { ...sanitizedInput };
    } catch (error) {
      if (error.statusCode === 400) lookupInput = { ...sanitizedInput };
      else throw error;
    }
    const result = await lookupServiceSchedule(lookupInput);
    res.json(result);
  } catch (error) {
    const status = error.statusCode === 400 ? 400 : 500;
    res.status(status).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'INTERNAL_ERROR',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
