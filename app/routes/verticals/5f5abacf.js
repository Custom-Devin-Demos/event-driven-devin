const express = require('express');
const { discoverSolutions, SOLUTION_TRACKS } = require('../../services/verticals/5f5abacf');

const router = express.Router();

router.get('/api/5f5abacf/solutions', (_req, res) => {
  res.json({ tracks: SOLUTION_TRACKS });
});

router.post('/api/5f5abacf/solutions/discover', async (req, res) => {
  try {
    const result = await discoverSolutions({
      track: req.body.track || 'artificial-intelligence',
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'SOLUTIONS_DISCOVERY_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
