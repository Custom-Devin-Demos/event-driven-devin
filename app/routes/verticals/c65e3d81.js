const express = require('express');
const router = express.Router();
const { processCoverageLookup, MEMBERS, RECENT_CLAIMS } = require('../../services/verticals/c65e3d81');

router.get('/api/c65e3d81/accounts', (_req, res) => {
  res.json({
    members: MEMBERS.map((m) => ({
      id: m.id,
      name: m.name,
      planType: m.planType,
    })),
    recentClaims: RECENT_CLAIMS,
  });
});

router.post('/api/c65e3d81/coverage', async (req, res) => {
  try {
    const result = await processCoverageLookup(req.body);
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
