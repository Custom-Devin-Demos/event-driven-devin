const express = require('express');
const {
  matchPrograms,
  FOCUS_AREAS,
  NETWORKS,
} = require('../../services/verticals/fd043af6');

const router = express.Router();

router.get('/api/fd043af6/catalog', (req, res) => {
  res.json({
    focusAreas: Object.entries(FOCUS_AREAS).map(([key, label]) => ({
      key,
      label,
    })),
    networks: Object.entries(NETWORKS).map(([key, network]) => ({
      key,
      label: network.label,
      institutionCount: network.institutions.length,
    })),
  });
});

router.post('/api/fd043af6/program-match', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await matchPrograms({
      company: body.company,
      email: body.email,
      teamSize: body.teamSize,
      focusArea: body.focusArea,
      network: body.network,
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
      code: error.code || 'PROGRAM_MATCH_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;
