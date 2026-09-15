const express = require('express');
const { releaseBatch, submitSupportTicket, BATCH, getBatchCompanies } = require('../../services/verticals/f8555891');

const router = express.Router();

router.get('/api/f8555891/batch', (_req, res) => {
  res.json({ batch: BATCH, companies: getBatchCompanies() });
});

router.post('/api/f8555891/release-batch', async (req, res) => {
  try {
    const body = req.body || {};
    const result = await releaseBatch({
      batchId: body.batchId || 'PB-2026-09-15-A',
      companyIds: body.companyIds,
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
      code: error.code || 'BATCH_RELEASE_FAILED',
      requestId: req.requestId,
    });
  }
});

router.post('/api/f8555891/support-ticket', async (req, res) => {
  try {
    const body = req.body || {};
    const result = await submitSupportTicket({
      subject: body.subject,
      text: body.text,
      reporter: body.reporter,
      severity: body.severity,
      productArea: body.productArea,
      split: Boolean(body.split),
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      ok: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'SUPPORT_TICKET_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
