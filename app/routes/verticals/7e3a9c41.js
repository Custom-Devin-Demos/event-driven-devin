const express = require('express');
const {
  adjudicateClaim,
  LINES_OF_BUSINESS,
} = require('../../services/verticals/7e3a9c41');

const router = express.Router();

function stringField(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return typeof value === 'string' ? value : null;
}

router.get('/api/7e3a9c41/plans', (_req, res) => {
  return res.json({
    linesOfBusiness: Object.entries(LINES_OF_BUSINESS).map(([id, lob]) => ({
      id,
      label: lob.label,
      network: lob.network,
    })),
    procedureCodes: ['99213', '99214', '71046', 'D0120'],
  });
});

router.post('/api/7e3a9c41/adjudicate', async (req, res) => {
  const body = req.body || {};
  const lineOfBusiness = stringField(body.lineOfBusiness, 'medicare_advantage');
  const memberId = stringField(body.memberId, '');
  const procedureCode = stringField(body.procedureCode, '');
  const providerNpi = stringField(body.providerNpi, '');
  const billedAmount = Number(body.billedAmount);

  if (!memberId) {
    return res.status(400).json({ success: false, error: 'memberId is required', code: 'VALIDATION_ERROR' });
  }
  if (!procedureCode) {
    return res.status(400).json({ success: false, error: 'procedureCode is required', code: 'VALIDATION_ERROR' });
  }
  if (!providerNpi || !/^\d{10}$/.test(providerNpi)) {
    return res.status(400).json({ success: false, error: 'providerNpi must be a 10-digit NPI', code: 'VALIDATION_ERROR' });
  }
  if (!Number.isFinite(billedAmount) || billedAmount <= 0) {
    return res.status(400).json({ success: false, error: 'billedAmount must be a positive number', code: 'VALIDATION_ERROR' });
  }
  if (!LINES_OF_BUSINESS[lineOfBusiness]) {
    return res.status(400).json({ success: false, error: `Unknown line of business: ${lineOfBusiness}`, code: 'VALIDATION_ERROR' });
  }

  try {
    const result = await adjudicateClaim({
      lineOfBusiness,
      memberId,
      procedureCode,
      providerNpi,
      billedAmount,
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
      code: error.code || 'ADJUDICATION_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
