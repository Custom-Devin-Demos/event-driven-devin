const express = require('express');
const { registerAttendee, PASS_CONFIGS, EVENT } = require('../../services/verticals/73575564');

const router = express.Router();

/**
 * GET /api/73575564/event — the event and its participation passes
 */
router.get('/api/73575564/event', (_req, res) => {
  const passes = Object.entries(PASS_CONFIGS).map(([id, config]) => ({ id, ...config }));
  res.json({
    event: { id: EVENT.id, title: EVENT.title, startsAt: EVENT.startsAt, registrationClosesAt: EVENT.registrationClosesAt },
    passes,
  });
});

/**
 * POST /api/73575564/register — submit a participation request
 */
router.post('/api/73575564/register', async (req, res) => {
  try {
    const result = await registerAttendee({
      passId: (req.body.passId || 'full-day').trim(),
      attendeeName: req.body.attendeeName || '山田 太郎',
      company: req.body.company || '',
      email: req.body.email || '',
      devinUsage: req.body.devinUsage || '',
      purpose: req.body.purpose || '',
      inviteCode: req.body.inviteCode || '',
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
