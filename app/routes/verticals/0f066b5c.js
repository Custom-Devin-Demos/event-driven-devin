const express = require('express');
const {
  processSwipe,
  getAppState,
  findProfile,
  SWIPE_DIRECTIONS,
} = require('../../services/verticals/0f066b5c');

const router = express.Router();

function badRequest(res, error) {
  return res.status(400).json({ success: false, error, errorClass: 'ValidationError', code: 'VALIDATION_ERROR' });
}

router.get('/api/0f066b5c/app', (req, res) => res.json(getAppState()));

router.post('/api/0f066b5c/swipes', async (req, res) => {
  const body = req.body || {};
  const direction = typeof body.direction === 'string' ? body.direction : '';
  const profile = findProfile(body.profileId);

  if (!profile) return badRequest(res, 'That profile is no longer available');
  if (!Object.prototype.hasOwnProperty.call(SWIPE_DIRECTIONS, direction)) {
    return badRequest(res, `Unknown swipe direction: ${direction}`);
  }

  try {
    const result = await processSwipe({
      profile,
      direction,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
      requestId: req.requestId,
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'MATCH_CREATE_FAILED',
      swipeId: error.swipeId,
      requestId: req.requestId,
    });
  }
});

module.exports = router;
