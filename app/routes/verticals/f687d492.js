const express = require('express');
const {
  publishOfficialClose,
  resetPublication,
  getOverview,
  listConstituents,
} = require('../../services/verticals/f687d492');
const { verifySessionSecret } = require('../../middleware/verify-session-secret');

const router = express.Router();

router.get('/api/f687d492/overview', (_req, res) => {
  res.json(getOverview());
});

router.get('/api/f687d492/constituents', (_req, res) => {
  res.json(listConstituents());
});

router.post('/api/f687d492/publish', verifySessionSecret, async (req, res) => {
  try {
    const result = await publishOfficialClose({
      trigger: 'manual',
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorType: error.name,
      overview: getOverview(),
    });
  }
});

router.post('/api/f687d492/publish/reset', verifySessionSecret, (_req, res) => {
  res.json(resetPublication());
});

module.exports = router;
