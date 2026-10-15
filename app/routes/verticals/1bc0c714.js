const express = require('express');
const { startPlaybackSession } = require('../../services/verticals/1bc0c714');

const router = express.Router();

router.post('/api/1bc0c714/playback-session', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await startPlaybackSession({
      titleId: body.titleId,
      device: body.device,
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
      code: error.code || 'PLAYBACK_SESSION_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;
