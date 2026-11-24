const express = require('express');
const {
  searchCases,
  COURT_SCOPES,
  CHAPTERS,
} = require('../../services/verticals/37b90289');

const router = express.Router();

router.get('/api/37b90289/courts', (_req, res) => {
  res.json({
    scopes: Object.entries(COURT_SCOPES).map(([key, scope]) => ({
      key,
      label: scope.label,
      courtCount: scope.courts.length,
    })),
    chapters: Object.entries(CHAPTERS).map(([key, label]) => ({ key, label })),
  });
});

router.post('/api/37b90289/case-search', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await searchCases({
      debtorName: body.debtorName,
      courtScope: body.courtScope,
      chapter: body.chapter,
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
      code: error.code || 'CASE_SEARCH_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;
