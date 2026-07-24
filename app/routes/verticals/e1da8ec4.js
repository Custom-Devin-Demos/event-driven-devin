const express = require('express');
const { processMissionBriefing, MISSION_DOMAINS } = require('../../services/verticals/e1da8ec4');

const router = express.Router();

/**
 * GET /api/e1da8ec4/domains — returns available mission domains
 */
router.get('/api/e1da8ec4/domains', (_req, res) => {
  res.json({
    domains: Object.entries(MISSION_DOMAINS).map(([id, d]) => ({
      id,
      label: d.label,
      programs: d.programs.map((p) => p.title),
    })),
  });
});

/**
 * POST /api/e1da8ec4/mission-briefing — generate a mission briefing summary
 */
router.post('/api/e1da8ec4/mission-briefing', async (req, res) => {
  try {
    const result = await processMissionBriefing({
      domain: req.body.domain || 'space',
      clearanceTier: req.body.clearanceTier || 'public',
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
      code: error.code || 'MISSION_BRIEFING_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
