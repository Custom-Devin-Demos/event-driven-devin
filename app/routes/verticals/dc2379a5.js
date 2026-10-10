const express = require('express');
const { requestTrustCenterAccess } = require('../../services/verticals/dc2379a5');

const router = express.Router();

router.post('/api/dc2379a5/trust-center/access-requests', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await requestTrustCenterAccess({
      fullName: body.fullName,
      workEmail: body.workEmail,
      company: body.company,
      reason: body.reason,
      documents: body.documents,
      ndaAccepted: body.ndaAccepted,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });

    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'ACCESS_REQUEST_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
