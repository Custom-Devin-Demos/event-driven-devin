const express = require('express');
const { CLINIC, DEVICE_MODELS, PATIENTS, REVISION, processTransmission } = require('../../services/verticals/acee28a2');
const { rehearsalReason, reportTransmissionError, REPO, BASE_BRANCH } = require('../../services/verticals/acee28a2-alert');
const router = express.Router();

router.get('/api/acee28a2/patients', (_req, res) => {
  res.json({ clinic: CLINIC, models: DEVICE_MODELS, patients: PATIENTS.map(({ finding: _finding, ...patient }) => patient), revision: REVISION, liveTeams: !rehearsalReason(), sourceUrl: `${REPO}/tree/${BASE_BRANCH}` });
});

router.post('/api/acee28a2/transmissions', async (req, res) => {
  try { res.json(processTransmission(req.body)); }
  catch (error) {
    const invalid = error.status === 400;
    const alert = invalid ? undefined : await reportTransmissionError(error, req.body);
    res.status(error.status || 500).json({ success: false, demo: true, alert, code: invalid ? 'INVALID_TRANSMISSION' : 'ALERT_ROUTING_FAILED', error: invalid ? error.message : 'The transmission was received but could not be processed.', diagnostic: error.message });
  }
});

module.exports = router;
