const express = require('express');
const { publishStory, listQueue } = require('../../services/verticals/a1c50ac4');

const router = express.Router();

router.get('/api/a1c50ac4/queue', (req, res) => {
  res.json({ stories: listQueue() });
});

router.post('/api/a1c50ac4/publish', (req, res) => {
  const body = req.body || {};
  try {
    const result = publishStory({
      articleId: body.articleId,
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
      code: error.code || 'PUBLISH_FAILED',
      requestId: error.requestId || req.requestId || null,
    });
  }
});

module.exports = router;
