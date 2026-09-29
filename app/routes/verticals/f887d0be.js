const express = require('express');
const {
  submitEnquiry,
  SERVICES,
  DOMICILES,
} = require('../../services/verticals/f887d0be');

const router = express.Router();

router.get('/api/f887d0be/services', (req, res) => {
  res.json({
    services: Object.entries(SERVICES).map(([key, s]) => ({
      key,
      label: s.label,
      requiresScreening: s.requiresScreening,
    })),
    domiciles: Object.entries(DOMICILES).map(([key, d]) => ({
      key,
      label: d.label,
    })),
  });
});

router.post('/api/f887d0be/enquiry', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await submitEnquiry({
      firstName: body.firstName,
      lastName: body.lastName,
      email: body.email,
      company: body.company,
      jobTitle: body.jobTitle,
      service: body.service,
      domicile: body.domicile,
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
      code: error.code || 'ENQUIRY_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;
