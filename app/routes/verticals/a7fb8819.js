const express = require('express');
const { submitPayRun, PAY_RUN, getPayRunEmployees } = require('../../services/verticals/a7fb8819');

const router = express.Router();

router.get('/api/a7fb8819/pay-run', (_req, res) => {
  res.json({ payRun: PAY_RUN, employees: getPayRunEmployees() });
});

router.post('/api/a7fb8819/submit-pay-run', async (req, res) => {
  try {
    const body = req.body || {};
    const result = await submitPayRun({
      payRunId: body.payRunId || 'PR-2026-09-15',
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
