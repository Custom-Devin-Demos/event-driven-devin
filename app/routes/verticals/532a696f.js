const express = require('express');
const {
  checkExpertAvailability,
  DELIVERY_CENTRES,
  REGION_SCOPES,
  COMPETENCIES,
} = require('../../services/verticals/532a696f');

const router = express.Router();

router.get('/api/532a696f/catalog', (_req, res) => {
  res.json({
    competencies: COMPETENCIES.map(({ key, label }) => ({ key, label })),
    regions: Object.entries(REGION_SCOPES).map(([key, scope]) => ({
      key,
      label: scope.label,
      centreCount: scope.centres.length,
    })),
    centres: DELIVERY_CENTRES.map(({ key, region, city }) => ({ key, region, city })),
  });
});

router.post('/api/532a696f/expert-availability', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await checkExpertAvailability({
      name: body.name,
      company: body.company,
      email: body.email,
      competency: body.competency,
      regions: body.regions,
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
      code: error.code || 'EXPERT_AVAILABILITY_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;
