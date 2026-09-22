const express = require('express');
const {
  issueCapitalCall,
  LIMITED_PARTNERS,
  FUND_VEHICLES,
  NOTICE_PURPOSES,
} = require('../../services/verticals/a1066f3a');

const router = express.Router();

const DEFAULT_LP_ID = 'lp-04417';

function has(map, key) {
  return typeof key === 'string' && Object.hasOwn(map, key);
}

function stringField(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return typeof value === 'string' ? value : null;
}

router.get('/api/a1066f3a/funds', (req, res) => {
  const lpId = stringField(req.query.lpId, DEFAULT_LP_ID);
  if (!has(LIMITED_PARTNERS, lpId)) {
    return res.status(400).json({ success: false, error: `Unknown limited partner: ${lpId}`, code: 'VALIDATION_ERROR' });
  }
  const lp = LIMITED_PARTNERS[lpId];
  return res.json({
    limitedPartner: { lpId, name: lp.name, shortName: lp.shortName, type: lp.type, domicile: lp.domicile, relationshipManager: lp.relationshipManager },
    funds: Object.entries(FUND_VEHICLES).map(([fundId, f]) => ({
      fundId,
      name: f.name,
      strategy: f.strategy,
      vintage: f.vintage,
      fundSizeMm: f.fundSizeMm,
      lpCommitmentMm: f.lpCommitmentMm,
      calledToDatePct: f.calledToDatePct,
      callNumber: f.callNumber,
      callTotalMm: f.callTotalMm,
      noticeDueDays: f.noticeDueDays,
      launched: f.launched,
      evergreen: f.evergreen,
    })),
    purposes: Object.entries(NOTICE_PURPOSES).map(([code, p]) => ({ code, label: p.label })),
  });
});

router.post('/api/a1066f3a/capital-calls', async (req, res) => {
  const issuedBy = typeof req.body.issuedBy === 'string' ? req.body.issuedBy.trim() : '';
  const fundId = stringField(req.body.fundId, '');
  const lpId = stringField(req.body.lpId, DEFAULT_LP_ID);
  const purpose = stringField(req.body.purpose, 'investment');

  if (!issuedBy) {
    return res.status(400).json({ success: false, error: 'issuedBy is required', code: 'VALIDATION_ERROR' });
  }
  if (!has(FUND_VEHICLES, fundId)) {
    return res.status(400).json({ success: false, error: `Unknown fund vehicle: ${fundId}`, code: 'VALIDATION_ERROR' });
  }
  if (!has(LIMITED_PARTNERS, lpId)) {
    return res.status(400).json({ success: false, error: `Unknown limited partner: ${lpId}`, code: 'VALIDATION_ERROR' });
  }
  if (!has(NOTICE_PURPOSES, purpose)) {
    return res.status(400).json({ success: false, error: `Unknown notice purpose: ${purpose}`, code: 'VALIDATION_ERROR' });
  }

  try {
    const result = await issueCapitalCall({
      issuedBy,
      fundId,
      lpId,
      purpose,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'CAPITAL_CALL_ISSUE_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
