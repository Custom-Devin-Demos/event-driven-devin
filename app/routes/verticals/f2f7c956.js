const express = require('express');
const { listLineup, startPlaybackSession } = require('../../services/verticals/f2f7c956');

const router = express.Router();

router.get('/api/f2f7c956/lineup', (req, res) => {
  res.json({ success: true, channels: listLineup() });
});

router.post('/api/f2f7c956/playback-session', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await startPlaybackSession({
      channel: body.channel,
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
