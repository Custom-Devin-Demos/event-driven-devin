const express = require('express');
const { loadContinueWatching, listProfiles } = require('../../services/verticals/a1eccdb6');

const router = express.Router();

router.get('/api/a1eccdb6/profiles', (req, res) => {
  res.json({ profiles: listProfiles() });
});

router.post('/api/a1eccdb6/continue-watching', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await loadContinueWatching({
      profileId: body.profileId ? String(body.profileId) : '',
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
      code: error.code || 'CW_RAIL_FAILED',
      sentryEventId: error.sentryEventId,
      jira: error.jira || null,
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;
