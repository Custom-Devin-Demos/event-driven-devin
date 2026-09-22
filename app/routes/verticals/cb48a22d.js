const express = require('express');
const {
  reserveEdCheckin,
  waitBoard,
  resolveFacility,
  FACILITIES,
} = require('../../services/verticals/cb48a22d');

const router = express.Router();

const REASONS = {
  'abdominal-pain': 'Abdominal pain',
  'breathing': 'Difficulty breathing',
  'chest-pain': 'Chest pain',
  'injury': 'Injury or fracture',
  'fever': 'Fever or infection',
};

function isCalendarDateInPast(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  if (parsed.toISOString().slice(0, 10) !== value) return false;
  return parsed.getTime() < Date.now();
}

router.get('/api/cb48a22d/waittimes', (_req, res) => {
  res.json({
    board: waitBoard(),
    facilities: FACILITIES,
    reasons: Object.entries(REASONS).map(([code, label]) => ({ code, label })),
  });
});

router.post('/api/cb48a22d/checkin', async (req, res) => {
  const body = req.body || {};
  const patientName = typeof body.patientName === 'string' ? body.patientName.trim() : '';
  const dateOfBirth = typeof body.dateOfBirth === 'string' ? body.dateOfBirth.trim() : '';
  const facilityCode = typeof body.facilityCode === 'string' ? body.facilityCode.trim().toUpperCase() : '';
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

  if (!patientName) {
    return res.status(400).json({ success: false, error: 'patientName is required', code: 'VALIDATION_ERROR' });
  }
  if (!isCalendarDateInPast(dateOfBirth)) {
    return res.status(400).json({ success: false, error: 'dateOfBirth must be a past YYYY-MM-DD date', code: 'VALIDATION_ERROR' });
  }
  if (!resolveFacility(facilityCode)) {
    return res.status(400).json({ success: false, error: `Unknown hospital: ${facilityCode}`, code: 'VALIDATION_ERROR' });
  }
  if (!Object.hasOwn(REASONS, reason)) {
    return res.status(400).json({ success: false, error: `Unknown reason for visit: ${reason}`, code: 'VALIDATION_ERROR' });
  }

  try {
    const result = await reserveEdCheckin({
      patientName,
      dateOfBirth,
      facilityCode,
      reason,
      reasonLabel: REASONS[reason],
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'ER_CHECKIN_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
