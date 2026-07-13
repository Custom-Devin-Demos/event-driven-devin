const express = require('express');
const { processDownloadRequest, RELEASES } = require('../../services/verticals/f36ef02a');

const router = express.Router();

router.get('/api/f36ef02a/releases', (_req, res) => {
  res.json({
    releases: RELEASES.map((r) => ({
      platform: r.platform,
      label: r.label,
    })),
  });
});

router.post('/api/f36ef02a/download', async (req, res) => {
  try {
    const result = await processDownloadRequest({
      platform: req.body.platform || 'web',
      channel: req.body.channel || 'stable',
      locale: req.body.locale || 'en-US',
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
      code: error.code || 'DOWNLOAD_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
