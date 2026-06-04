const express = require('express');
const router = express.Router();
const { processCompanyLookup, COMPANIES, RECENT_SCREENS } = require('../../services/verticals/spglobal');

router.get('/api/spglobal/companies', (_req, res) => {
  res.json({
    companies: COMPANIES.map((c) => ({
      ticker: c.ticker,
      name: c.name,
      sector: c.sector,
      exchange: c.exchange,
      rating: c.rating,
    })),
    recentScreens: RECENT_SCREENS,
  });
});

router.post('/api/spglobal/financials', async (req, res) => {
  try {
    const result = await processCompanyLookup({
      ticker: req.body.ticker,
      cik: req.body.cik,
      sector: req.body.sector,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(error.code === 'COMPANY_NOT_FOUND' ? 404 : 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'LOOKUP_FAILED',
    });
  }
});

module.exports = router;
