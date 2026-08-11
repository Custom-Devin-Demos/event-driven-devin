const express = require('express');
const { adjudicateClaim, SERVICE_CATALOG } = require('../../services/verticals/31328569');

const router = express.Router();

router.get('/api/31328569/catalog', (_req, res) => {
  res.json({ services: SERVICE_CATALOG });
});

router.post('/api/31328569/claim', async (req, res) => {
  try {
    const result = await adjudicateClaim({
      memberId: req.body.memberId || 'anonymous',
      lines: req.body.lines || [{ code: 'CPT-99213', qty: 1, billed: 185.00 }],
      billedTotal: req.body.billedTotal || 185.00,
      plan: req.body.plan || 'CHOICE_PLUS',
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'CLAIM_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
