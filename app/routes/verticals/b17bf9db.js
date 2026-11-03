const express = require('express');
const {
  processQuote,
  lookupVehicle,
  COVER_TYPES,
  VOLUNTARY_EXCESS,
} = require('../../services/verticals/b17bf9db');

const router = express.Router();

function badRequest(res, error) {
  return res.status(400).json({ success: false, error, errorClass: 'ValidationError', code: 'VALIDATION_ERROR' });
}

function str(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

router.get('/api/b17bf9db/vehicles/:registration', (req, res) => {
  const vehicle = lookupVehicle(req.params.registration);
  if (!vehicle) {
    return res.status(404).json({ success: false, error: "Sorry, we couldn't find a car with that registration", code: 'VEHICLE_NOT_FOUND' });
  }
  return res.json({ success: true, vehicle });
});

router.post('/api/b17bf9db/quotes', async (req, res) => {
  const body = req.body || {};
  const vehicle = lookupVehicle(body.registration);
  const rawDriver = body.driver || {};
  const rawCover = body.cover || {};

  if (!vehicle) return badRequest(res, 'Please enter a valid UK registration');

  const driver = {
    title: str(rawDriver.title, 'Mr'),
    firstName: str(rawDriver.firstName),
    lastName: str(rawDriver.lastName),
    dateOfBirth: str(rawDriver.dateOfBirth),
    postcode: str(rawDriver.postcode).toUpperCase(),
    occupation: str(rawDriver.occupation),
    licenceYears: Number(rawDriver.licenceYears) || 0,
  };
  const cover = {
    type: str(rawCover.type, 'comprehensive'),
    startDate: str(rawCover.startDate),
    annualMileage: Number(rawCover.annualMileage) || 0,
    voluntaryExcess: Number(rawCover.voluntaryExcess) || 0,
    ncdYears: Number(rawCover.ncdYears) || 0,
    paymentFrequency: str(rawCover.paymentFrequency, 'annually'),
  };

  if (!driver.firstName || !driver.lastName) return badRequest(res, 'Please tell us your name');
  if (Number.isNaN(Date.parse(driver.dateOfBirth))) return badRequest(res, 'Please enter a valid date of birth');
  if (!/^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/.test(driver.postcode)) return badRequest(res, 'Please enter a valid UK postcode');
  if (!Object.hasOwn(COVER_TYPES, cover.type)) return badRequest(res, `Unknown cover type: ${cover.type}`);
  if (!Object.hasOwn(VOLUNTARY_EXCESS, cover.voluntaryExcess)) return badRequest(res, 'Please choose a voluntary excess');
  if (cover.annualMileage < 500 || cover.annualMileage > 50000) return badRequest(res, 'Annual mileage must be between 500 and 50,000');

  try {
    const result = await processQuote({
      vehicle,
      driver,
      cover,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
      requestId: req.requestId,
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'QUOTE_ENGINE_FAILED',
      quoteRef: error.quoteRef,
      requestId: req.requestId,
    });
  }
});

module.exports = router;
