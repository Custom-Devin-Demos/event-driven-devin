const express = require('express');
const {
  AddressValidationError,
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
  const respondWithError = (status, error) => res.status(status).json({
    success: false,
    error: error.message,
    errorClass: error.name,
    code: error.code || 'INTERNAL_ERROR',
    requestId: req.requestId,
  });
  try {
    const parsed = parseAddress(req.body && req.body.address);
    if (!SERVICE_ZIPS.has(parsed.zip)) {
      throw new AddressValidationError(`ZIP ${parsed.zip} is outside our current service area`);
    }
    const result = await lookupServiceSchedule(sanitizeLookupInput(req.body));
    res.json(result);
  } catch (error) {
    respondWithError(error.statusCode === 400 ? 400 : 500, error);
  }
});

module.exports = router;
