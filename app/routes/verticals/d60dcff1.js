const express = require('express');
const { approveDocument, REVIEW_DOCUMENT } = require('../../services/verticals/d60dcff1');

const router = express.Router();

// Reproduction mode lets a remediation session fail the approval on camera without
// re-raising the incident it was created from. Ignored in production.
function isReproductionRequest(req) {
  return Boolean(req.headers['x-synthetic']) && process.env.NODE_ENV !== 'production';
}

router.get('/api/d60dcff1/review/document', (_req, res) => {
  res.json(REVIEW_DOCUMENT);
});

router.post('/api/d60dcff1/review/approve', async (req, res) => {
  const body = req.body || {};

  try {
    const result = await approveDocument({
      documentId: body.documentId,
      configVersion: body.configVersion,
      reviewer: body.reviewer,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
      synthetic: isReproductionRequest(req),
    });
    res.json(result);
  } catch (error) {
    if (error.statusCode === 400 || error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: error.message,
        errorClass: error.name,
        code: error.code || 'INVALID_REVIEW',
        requestId: error.requestId || req.requestId,
      });
    }

    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: 'APPROVAL_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;
