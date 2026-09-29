const express = require('express');
const { runColumn, getMatrix } = require('../../services/verticals/7a925867');

const router = express.Router();

router.get('/api/7a925867/matrix', (_req, res) => {
  res.json(getMatrix());
});

router.post('/api/7a925867/matrix/columns/run', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await runColumn({
      column: body.column,
      documentIds: body.documentIds,
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
      code: error.code || 'MATRIX_COLUMN_RUN_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;
