const express = require('express');
const {
  search,
  listAccounts,
  getAccountPolicies,
  AGENCY,
} = require('../../services/verticals/19381609');

const router = express.Router();

function errorBody(error, req) {
  return {
    success: false,
    error: error.statusCode === 400 ? error.message : 'Applied Epic could not complete this search.',
    errorClass: error.name || 'Error',
    code: error.code || 'SEARCH_FAILED',
    requestId: error.requestId || req.requestId || null,
  };
}

router.get('/api/19381609/accounts', (_req, res) => {
  res.json({ agency: AGENCY, accounts: listAccounts() });
});

router.get('/api/19381609/accounts/:lookupCode/policies', (req, res) => {
  const result = getAccountPolicies(req.params.lookupCode);
  if (!result) {
    return res.status(404).json({
      success: false,
      error: `Account ${req.params.lookupCode} was not found.`,
      errorClass: 'NotFoundError',
      code: 'ACCOUNT_NOT_FOUND',
      requestId: req.requestId || null,
    });
  }
  res.json({ success: true, ...result });
});

router.post('/api/19381609/search', async (req, res) => {
  const body = req.body || {};
  try {
    res.json(await search({
      query: body.query,
      type: body.type,
      status: body.status,
      date: body.date,
      sort: body.sort,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    }, { requestId: req.requestId }));
  } catch (error) {
    res.status(error.statusCode || 500).json(errorBody(error, req));
  }
});

module.exports = router;
