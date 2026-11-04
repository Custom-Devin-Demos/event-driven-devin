const express = require('express');
const { signEncounter, getSchedule, getChart, PATIENTS } = require('../../services/verticals/e8947398');

const router = express.Router();

function knownPatient(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(PATIENTS, id);
}

router.get('/api/e8947398/schedule', (req, res) => {
  res.json({ success: true, ...getSchedule() });
});

router.get('/api/e8947398/patients/:id/chart', (req, res) => {
  if (!knownPatient(req.params.id)) {
    return res.status(404).json({ success: false, error: 'Unknown patient', code: 'NOT_FOUND' });
  }
  return res.json({ success: true, chart: getChart(req.params.id) });
});

router.post('/api/e8947398/encounters/sign', async (req, res) => {
  const body = req.body || {};
  if (!knownPatient(body.patientId)) {
    return res.status(400).json({ success: false, error: 'Unknown patient', code: 'VALIDATION_ERROR' });
  }
  if (body.attested !== true) {
    return res.status(400).json({ success: false, error: 'Provider attestation is required to sign the encounter', code: 'VALIDATION_ERROR' });
  }

  try {
    const result = await signEncounter({
      patientId: body.patientId,
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
      code: 'CHARGE_POST_FAILED',
      encounterRef: error.encounterRef,
      requestId: req.requestId,
    });
  }
});

module.exports = router;
