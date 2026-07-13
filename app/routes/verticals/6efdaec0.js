const express = require('express');
const { processSignIn, TITLES } = require('../../services/verticals/6efdaec0');

const router = express.Router();

/**
 * GET /api/6efdaec0/titles — returns available titles
 */
router.get('/api/6efdaec0/titles', (_req, res) => {
  res.json({
    titles: TITLES.map((t) => ({
      code: t.code,
      name: t.name,
      regions: t.regions,
    })),
  });
});

/**
 * POST /api/6efdaec0/signin — player sign-in and session bootstrap
 */
router.post('/api/6efdaec0/signin', async (req, res) => {
  try {
    const result = await processSignIn({
      region: req.body.region || 'NA1',
      channel: req.body.channel || 'web',
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
      code: error.code || 'SIGNIN_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
