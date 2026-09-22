const express = require('express');
const { renderInviteScreen, EVENTS } = require('../../services/verticals/ce9afcfc');

const router = express.Router();

/**
 * GET /api/ce9afcfc/events — events in the demo account, as the feed shows them
 */
router.get('/api/ce9afcfc/events', (_req, res) => {
  res.json({
    events: Object.values(EVENTS).map((event) => ({
      id: event.id,
      title: event.title,
      emoji: event.emoji,
      host: event.host,
      theme: event.theme,
      pill: event.pill,
      venue: event.venue,
      thumbnail: event.coverPhoto ? event.coverPhoto.url : null,
    })),
  });
});

/**
 * POST /api/ce9afcfc/invite-screen — open an invite link
 */
router.post('/api/ce9afcfc/invite-screen', async (req, res) => {
  try {
    const screen = await renderInviteScreen({
      eventId: req.body.eventId,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json({
      success: true,
      hero: screen.hero,
      heroAspectRatio: screen.heroAspectRatio,
      screen,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'INVITE_SCREEN_RENDER_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
