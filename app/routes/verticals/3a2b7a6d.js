const express = require('express');
const { submitIntake, CLINICIANS, PATIENTS, VISIT_TYPES } = require('../../services/verticals/3a2b7a6d');

const router = express.Router();

router.get('/api/3a2b7a6d/context', (_req, res) => {
  res.json({ clinicians: CLINICIANS, patients: PATIENTS, visitTypes: VISIT_TYPES });
});

router.post('/api/3a2b7a6d/intake', async (req, res) => {
  try {
    res.json(await submitIntake(req.body || {}));
  } catch (error) {
    res.status(error.name === 'ValidationError' ? 400 : 500).json({
      success: false, error: error.message, errorClass: error.name,
      code: error.name === 'ValidationError' ? 'INVALID_REQUEST' : 'INTAKE_FAILED', requestId: req.requestId,
    });
  }
});

module.exports = router;
