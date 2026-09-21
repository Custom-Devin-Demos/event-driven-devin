const express = require('express');
const { runLineBalanceCycle, getOverview } = require('../../services/verticals/b4c3a7fc');

const router = express.Router();

router.get('/api/b4c3a7fc/overview', (_req, res) => {
  res.json(getOverview());
});

router.post('/api/b4c3a7fc/line-balance/run', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await runLineBalanceCycle({
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message, errorType: error.name });
  }
});

module.exports = router;
