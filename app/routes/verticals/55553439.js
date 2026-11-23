const express = require('express');
const { listLineup, startLivePlayback } = require('../../services/verticals/55553439');

const router = express.Router();

// Sliding-window limiter for the public playback endpoint.
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 30;
const hits = new Map();

function reserveSlot(key) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  return true;
}

router.get('/api/55553439/lineup', (_req, res) => {
  res.json({ channels: listLineup() });
});

router.post('/api/55553439/playback', async (req, res) => {
  const key = req.ip || 'unknown';
  if (!reserveSlot(key)) {
    res.status(429).json({ success: false, error: 'Too many requests', code: 'RATE_LIMITED', requestId: req.requestId });
    return;
  }

  const body = req.body || {};
  try {
    const result = await startLivePlayback({
      channelId: typeof body.channelId === 'string' ? body.channelId : 'nbc-news-now',
      viewerUserId: body.devinUserId,
      viewerOrgId: body.devinOrgId,
      viewerEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'PLAYBACK_START_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;
