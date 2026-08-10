const express = require('express');
const { submitInquiry, ENABLED_TOPICS } = require('../../services/verticals/edaa5b9f');

const router = express.Router();

router.get('/api/edaa5b9f/topics', (_req, res) => {
  res.json({ topics: ENABLED_TOPICS });
});

router.post('/api/edaa5b9f/contact', async (req, res) => {
  try {
    const result = await submitInquiry({
      name: req.body.name || 'Guest',
      email: req.body.email || '',
      topic: req.body.topic || 'streaming',
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
      code: error.code || 'INQUIRY_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
