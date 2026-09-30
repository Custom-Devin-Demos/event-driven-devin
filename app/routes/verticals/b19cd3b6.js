const express = require('express');
const { postDailySalesSummary, getDailySalesSummary, LOCATIONS } = require('../../services/verticals/b19cd3b6');

const router = express.Router();

router.get('/api/b19cd3b6/locations', (req, res) => {
  res.json({
    locations: Object.values(LOCATIONS).map((l) => ({ id: l.number, name: l.name, concept: l.concept })),
  });
});

router.get('/api/b19cd3b6/dss', (req, res) => {
  const dss = getDailySalesSummary(String(req.query.locationId || ''), undefined);
  if (!dss) {
    res.status(404).json({ success: false, error: 'Unknown location.' });
    return;
  }
  res.json({ success: true, dss });
});

router.post('/api/b19cd3b6/dss/post', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await postDailySalesSummary({
      locationId: body.locationId ? String(body.locationId) : '',
      businessDate: body.businessDate,
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
      code: error.code || 'DSS_POST_FAILED',
      postId: error.postId,
      sentryEventId: error.sentryEventId,
      jira: error.jira || null,
      requestId: req.requestId,
    });
  }
});

module.exports = router;
