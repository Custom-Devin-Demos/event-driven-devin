const express = require('express');
const { listPendingApprovals, approvePayment } = require('../../services/verticals/09bd61b4');

const router = express.Router();

router.get('/api/09bd61b4/approvals', (_req, res) => {
  res.json({ payments: listPendingApprovals() });
});

router.post('/api/09bd61b4/payments/:id/approve', (req, res) => {
  try {
    const result = approvePayment(req.params.id, req.body || {}, req.requestId);
    res.status(result.statusCode).json(result.body);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name || 'Error',
      code: error.code || 'APPROVAL_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
