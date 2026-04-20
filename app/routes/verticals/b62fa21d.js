const express = require('express');
const router = express.Router();
const { processRewardsLookup, MEMBERS, RECENT_PURCHASES } = require('../../services/verticals/b62fa21d');

router.get('/api/b62fa21d/accounts', (_req, res) => {
  res.json({
    members: MEMBERS.map((m) => ({
      id: m.id,
      name: m.name,
      tier: m.tier,
    })),
    recentPurchases: RECENT_PURCHASES,
  });
});

router.post('/api/b62fa21d/rewards', async (req, res) => {
  try {
    const result = await processRewardsLookup(req.body);
    res.json(result);
  } catch (error) {
    res.status(error.code === 'MEMBER_NOT_FOUND' ? 404 : 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
    });
  }
});

module.exports = router;
