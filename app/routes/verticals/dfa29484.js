const express = require('express');
const { getCapitalAccount, generateStatement, getStatementDocument } = require('../../services/verticals/dfa29484');

const router = express.Router();

function sendError(req, res, error, fallbackCode) {
  res.status(error.statusCode || 500).json({
    success: false,
    error: error.message,
    errorClass: error.name,
    code: error.code || fallbackCode,
    requestId: error.requestId || req.requestId,
    vehicleId: error.vehicleId || null,
    rows: error.rows || [],
  });
}

router.get('/api/dfa29484/capital-account', (_req, res) => {
  res.json(getCapitalAccount());
});

router.post('/api/dfa29484/statements', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await generateStatement({
      periodId: body.periodId,
      vehicleIds: body.vehicleIds,
      format: body.format,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    sendError(req, res, error, 'STATEMENT_RENDER_FAILED');
  }
});

router.get('/api/dfa29484/statements/:statementId/download', (req, res) => {
  try {
    const { filename, contentType, body } = getStatementDocument(req.params.statementId);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(body);
  } catch (error) {
    sendError(req, res, error, 'STATEMENT_DOWNLOAD_FAILED');
  }
});

module.exports = router;
