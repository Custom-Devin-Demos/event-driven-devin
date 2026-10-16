const express = require('express');
const {
  MATTER,
  HOLD_NOTICES,
  CUSTODIANS,
  releaseCustodians,
} = require('../../services/verticals/d2dd4b8e');

const router = express.Router();

router.get('/api/d2dd4b8e/hold-notices/:id', (req, res) => {
  const notice = HOLD_NOTICES.find((candidate) => candidate.id === req.params.id);
  if (!notice) {
    return res.status(404).json({
      success: false,
      error: `Unknown hold notice: ${req.params.id}`,
      code: 'UNKNOWN_HOLD_NOTICE',
    });
  }

  return res.json({ matter: MATTER, notice, custodians: CUSTODIANS });
});

router.post('/api/d2dd4b8e/release-custodians', async (req, res) => {
  try {
    const body = req.body || {};
    const result = await releaseCustodians({
      holdNoticeId: body.holdNoticeId,
      custodianIds: body.custodianIds,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    return res.json(result);
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'CUSTODIAN_RELEASE_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
