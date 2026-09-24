const express = require('express');
const { searchMedications, resetSearch, getCatalog } = require('../../services/verticals/f0fc78cc');

const router = express.Router();

router.get('/api/f0fc78cc/catalog', (_req, res) => {
  res.json(getCatalog());
});

router.post('/api/f0fc78cc/search', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await searchMedications({
      term: body.term,
      alternative: body.alternative,
      page: body.page,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message, errorType: error.name });
  }
});

router.post('/api/f0fc78cc/search/reset', (_req, res) => {
  res.json(resetSearch());
});

module.exports = router;
