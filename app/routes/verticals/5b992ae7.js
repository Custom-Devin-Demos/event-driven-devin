const express = require('express');
const { submitInquiry, ENGINE_PROGRAMS } = require('../../services/verticals/5b992ae7');

const router = express.Router();

/**
 * GET /api/5b992ae7/programs — engine program catalog
 */
router.get('/api/5b992ae7/programs', (_req, res) => {
  res.json({
    programs: Object.values(ENGINE_PROGRAMS).map((program) => ({
      code: program.code,
      name: program.name,
      family: program.family,
      inService: program.inService,
    })),
  });
});

/**
 * POST /api/5b992ae7/inquiry — submit a customer support inquiry
 */
router.post('/api/5b992ae7/inquiry', async (req, res) => {
  try {
    const summary = await submitInquiry({
      topic: req.body.topic || 'commercial-support',
      market: req.body.market || 'US',
      source: req.body.source,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(summary);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'INQUIRY_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
