const express = require('express');
const { requestLiveEntitlement } = require('../../services/verticals/fox');

const router = express.Router();

/**
 * POST /api/fox/live/entitlement — issue a live-stream entitlement for a FOX channel.
 *
 * Called by the FOX tvOS app (COG-GTM/fox-tvos); there is no web page for
 * this vertical.
 */
router.post('/api/fox/live/entitlement', async (req, res) => {
  try {
    const result = await requestLiveEntitlement({
      profileId: req.body.profile_id || req.body.profileId,
      channelId: req.body.channel_id || req.body.channelId,
      device: req.body.device,
      client: req.get('X-Fox-Client'),
      demoToken: req.get('X-Fox-Demo-Token'),
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.name || 'Error',
      message: error.message,
      code: error.code || 'LIVE_ENTITLEMENT_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
