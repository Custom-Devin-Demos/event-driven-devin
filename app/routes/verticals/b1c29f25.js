const express = require('express');
const { authorizeAccess, DOCUMENTS } = require('../../services/verticals/b1c29f25');

const router = express.Router();

router.get('/api/b1c29f25/documents', (_req, res) => {
  res.json({ documents: DOCUMENTS });
});

router.post('/api/b1c29f25/authorize', async (req, res) => {
  try {
    const result = await authorizeAccess({
      memberId: req.body.memberId || 'MBR-0000000',
      documents: req.body.documents || [
        { id: 'DOC-EOB-Q2', scopeId: 'SCOPE-BENEFITS-READ' },
        { id: 'DOC-BH-NOTES', scopeId: 'SCOPE-BH-READ' },
      ],
      verifyMethod: req.body.verifyMethod || 'mfa_app',
      region: req.body.region || 'US',
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
      code: error.code || 'AUTHZ_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
