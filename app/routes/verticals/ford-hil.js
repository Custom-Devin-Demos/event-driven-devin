const express = require('express');
const { rerunHilTest, NIGHTLY_RESULTS } = require('../../services/verticals/ford-hil');

const router = express.Router();

/**
 * GET /api/ford-hil/results — returns nightly HIL test results
 */
router.get('/api/ford-hil/results', (_req, res) => {
  res.json({ results: NIGHTLY_RESULTS });
});

/**
 * POST /api/ford-hil/rerun — re-run a HIL test on the bench
 */
router.post('/api/ford-hil/rerun', async (req, res) => {
  try {
    const result = await rerunHilTest({
      testId: req.body.testId || 'HIL-ADAS-031',
      ecuTarget: req.body.ecuTarget || 'ADAS_v12.0.4',
      signalProfile: req.body.signalProfile || 'highway_75mph',
      sampleRate: req.body.sampleRate || 200,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'HIL_TEST_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
