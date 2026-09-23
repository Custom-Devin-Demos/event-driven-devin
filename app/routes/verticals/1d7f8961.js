const express = require('express');
const { releaseDisbursement } = require('../../services/verticals/1d7f8961');

const router = express.Router();

/**
 * POST /api/1d7f8961/disbursement — release an approved payroll cycle
 */
router.post('/api/1d7f8961/disbursement', async (req, res) => {
  try {
    const confirmation = await releaseDisbursement({
      fromAccount: req.body.fromAccount,
      toAccount: req.body.toAccount,
      amount: req.body.amount,
      runType: req.body.runType,
      employeeCount: req.body.employeeCount,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(confirmation);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'DISBURSEMENT_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
