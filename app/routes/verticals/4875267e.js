const express = require('express');
const { registerAttendee, SLOT_CONFIGS, EVENT } = require('../../services/verticals/4875267e');

const router = express.Router();

/**
 * GET /api/4875267e/event — the event and its participation slots
 */
router.get('/api/4875267e/event', (_req, res) => {
  const slots = Object.entries(SLOT_CONFIGS).map(([id, config]) => ({
    id,
    ...config,
    confirmed: EVENT.registrations[id] || 0,
  }));
  res.json({ event: { id: EVENT.id, title: EVENT.title, startsAt: EVENT.startsAt }, slots });
});

/**
 * POST /api/4875267e/register — register an attendee for a slot
 */
router.post('/api/4875267e/register', async (req, res) => {
  try {
    const result = await registerAttendee({
      slotId: (req.body.slotId || 'general').trim(),
      displayName: req.body.displayName || 'tanaka_m',
      experience: req.body.experience || '',
      referral: req.body.referral || '',
      message: req.body.message || '',
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
      code: error.code || 'REGISTRATION_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
