const express = require('express');
const {
  submitStreetlightReport,
  SERVICE_TERRITORIES,
  RECENT_STREETLIGHT_REPORTS,
} = require('../../services/verticals/c9944b42');

const router = express.Router();

router.get('/api/c9944b42/reports', (_req, res) => {
  res.json({ reports: RECENT_STREETLIGHT_REPORTS, territories: SERVICE_TERRITORIES });
});

router.post('/api/c9944b42/streetlight', async (req, res) => {
  try {
    const result = await submitStreetlightReport({
      address: req.body.address || '1234 Market St',
      city: req.body.city || 'San Francisco',
      zip: req.body.zip || '94103',
      poleId: req.body.poleId || 'P-4410-227',
      issue: req.body.issue || 'Light out',
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
      sourcePage: req.body.sourcePage,
    });
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
