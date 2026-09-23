const express = require('express');
const { submitPayRun, getPayRun } = require('../../services/verticals/e33c0578');

const router = express.Router();

router.get('/api/e33c0578/pay-run', (req, res) => {
  res.json(getPayRun());
});

router.post('/api/e33c0578/pay-run', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await submitPayRun({
      payGroupId: body.payGroupId,
      employeeIds: body.employeeIds,
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
      code: error.code || 'PAY_RUN_SUBMISSION_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
