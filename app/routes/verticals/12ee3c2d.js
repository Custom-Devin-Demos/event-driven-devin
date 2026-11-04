const express = require('express');
const {
  getPortal, saveColumnLayout, respondToDispute, SETTLEMENT_COLUMNS, DISPUTES,
} = require('../../services/verticals/12ee3c2d');

const router = express.Router();
const COLUMN_KEYS = new Set(SETTLEMENT_COLUMNS.map((c) => c.key));

router.get('/api/12ee3c2d/portal', (req, res) => {
  res.json({ success: true, ...getPortal() });
});

router.post('/api/12ee3c2d/settlements/columns', async (req, res) => {
  const body = req.body || {};
  const layout = Array.isArray(body.layout) ? body.layout : null;
  if (!layout || layout.length === 0) {
    return res.status(400).json({ success: false, error: 'At least one active column is required', code: 'VALIDATION_ERROR' });
  }
  if (layout.some((k) => typeof k !== 'string' || !COLUMN_KEYS.has(k)) || new Set(layout).size !== layout.length) {
    return res.status(400).json({ success: false, error: 'Unknown or duplicate column', code: 'VALIDATION_ERROR' });
  }

  try {
    const result = await saveColumnLayout({
      layout,
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
      code: 'COLUMN_PREFERENCES_SAVE_FAILED',
      preferenceRef: error.preferenceRef,
      requestId: req.requestId,
    });
  }
});

router.post('/api/12ee3c2d/disputes/:caseNumber/respond', (req, res) => {
  const body = req.body || {};
  if (!DISPUTES.some((d) => d.caseNumber === req.params.caseNumber)) {
    return res.status(404).json({ success: false, error: 'Case not found', code: 'NOT_FOUND' });
  }
  if (!['disagree', 'refund'].includes(body.responseType)) {
    return res.status(400).json({ success: false, error: 'Choose a response type', code: 'VALIDATION_ERROR' });
  }
  if (typeof body.initials !== 'string' || !/^[A-Za-z]{2,3}$/.test(body.initials.trim())) {
    return res.status(400).json({ success: false, error: 'Enter your initials to verify your response', code: 'VALIDATION_ERROR' });
  }
  return res.json(respondToDispute(req.params.caseNumber, body));
});

module.exports = router;
