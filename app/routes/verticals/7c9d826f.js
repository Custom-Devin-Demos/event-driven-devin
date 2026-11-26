const express = require('express');
const { listDocuments, submitDocument } = require('../../services/verticals/7c9d826f');
const router = express.Router();

router.get('/api/7c9d826f/documents', (_req, res) => res.json({ documents: listDocuments() }));

router.post('/api/7c9d826f/documents/:id/submit', async (req, res) => {
  const body = req.body || {};
  try {
    res.json(await submitDocument({
      documentId: req.params.id,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    }));
  } catch (error) {
    res.status(error.status || 500).json({
      success: false, error: error.message, errorClass: error.name,
      code: error.code || 'SUBMISSION_FAILED', rejection: error.rejection, requestId: req.requestId,
    });
  }
});

module.exports = router;
