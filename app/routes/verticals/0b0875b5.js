const express = require('express');
const {
  processFluAppointment,
  resetFluAppointments,
  getCatalog,
} = require('../../services/verticals/0b0875b5');
const { verifySessionSecret } = require('../../middleware/verify-session-secret');

const router = express.Router();

router.get('/api/0b0875b5/catalog', (_req, res) => {
  res.json(getCatalog());
});

router.post('/api/0b0875b5/schedule', verifySessionSecret, async (req, res) => {
  const body = req.body || {};
  try {
    const result = await processFluAppointment({
      storeNumber: body.storeNumber,
      patientAge: body.patientAge,
      source: body.source,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message, errorType: error.name });
  }
});

router.post('/api/0b0875b5/schedule/reset', (_req, res) => {
  res.json(resetFluAppointments());
});

module.exports = router;
