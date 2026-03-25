const express = require('express');
const {
  getCreditReport,
  refreshScore,
  resetBug,
  getBugState,
  CREDIT_PROFILE,
  SCORE_FACTORS,
  RECOMMENDATIONS,
} = require('../../services/verticals/intuit');

const router = express.Router();

/**
 * GET /api/intuit/score — returns the full credit report
 */
router.get('/api/intuit/score', async (req, res) => {
  try {
    const result = await getCreditReport({
      userId: req.query.userId || CREDIT_PROFILE.userId,
      devinUserId: req.query.devinUserId,
      devinOrgId: req.query.devinOrgId,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'SCORE_FETCH_FAILED',
      requestId: req.requestId,
    });
  }
});

/**
 * POST /api/intuit/refresh — refresh score (triggers the bug / incident)
 */
router.post('/api/intuit/refresh', async (req, res) => {
  try {
    const result = await refreshScore({
      userId: req.body.userId || CREDIT_PROFILE.userId,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'SCORE_REFRESH_FAILED',
      requestId: req.requestId,
    });
  }
});

/**
 * POST /api/intuit/reset — toggle the bug on or off
 * Body: { "bugActive": true|false } or empty to toggle
 */
router.post('/api/intuit/reset', (req, res) => {
  const state = resetBug(req.body.bugActive);
  res.json({
    success: true,
    message: `Bug is now ${state.current ? 'ACTIVE' : 'FIXED'}`,
    ...state,
  });
});

/**
 * GET /api/intuit/status — check current bug state
 */
router.get('/api/intuit/status', (_req, res) => {
  res.json({
    ...getBugState(),
    profile: CREDIT_PROFILE,
    factorCount: Object.keys(SCORE_FACTORS).length,
    recommendationCount: RECOMMENDATIONS.length,
  });
});

module.exports = router;
