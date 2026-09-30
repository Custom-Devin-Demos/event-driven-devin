const express = require('express');
const { searchPortfolio } = require('../../services/verticals/0fb68d91');

const router = express.Router();

router.post('/api/0fb68d91/portfolio/search', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await searchPortfolio({
      keyword: body.keyword,
      filters: body.filters,
      sort: body.sort,
      page: body.page,
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
      code: error.code || 'PORTFOLIO_SEARCH_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
