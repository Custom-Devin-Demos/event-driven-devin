const express = require('express');
const { getPortal, revealWireInstructions } = require('../../services/verticals/ed1d21a0');

const router = express.Router();

router.get('/api/ed1d21a0/portal', (_req, res) => {
  res.json(getPortal());
});

router.post('/api/ed1d21a0/invoices/:invoiceId/wire', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await revealWireInstructions({
      invoiceId: req.params.invoiceId,
      mfaCode: body.mfaCode,
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
      code: error.code || 'WIRE_INSTRUCTIONS_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;
