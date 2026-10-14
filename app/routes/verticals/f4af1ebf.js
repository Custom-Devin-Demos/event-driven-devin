const express = require('express');
const { listLoads, indexDocument, submitToBilling } = require('../../services/verticals/f4af1ebf');

const router = express.Router();

function sendError(res, req, error, fallbackCode) {
  res.status(error.statusCode || 500).json({
    success: false,
    error: error.message,
    errorClass: error.name,
    code: error.code || fallbackCode,
    requestId: error.requestId || req.requestId,
  });
}

router.get('/api/f4af1ebf/loads', (_req, res) => {
  res.json(listLoads());
});

router.post('/api/f4af1ebf/documents/index', async (req, res) => {
  const body = req.body || {};
  try {
    res.json(await indexDocument({ loadId: body.loadId, documentId: body.documentId }));
  } catch (error) {
    sendError(res, req, error, 'DOCUMENT_INDEX_FAILED');
  }
});

router.post('/api/f4af1ebf/billing/submit', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await submitToBilling({
      loadId: body.loadId,
      documentId: body.documentId,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    sendError(res, req, error, 'BILLING_SUBMIT_FAILED');
  }
});

module.exports = router;
