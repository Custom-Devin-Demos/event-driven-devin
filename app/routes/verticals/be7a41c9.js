const express = require('express');
const { submitInquiry, INQUIRY_TOPICS, NETWORK_STATS } = require('../../services/verticals/be7a41c9');

const router = express.Router();

/**
 * GET /api/be7a41c9/topics — inquiry topics offered on the contact form
 */
router.get('/api/be7a41c9/topics', (_req, res) => {
  res.json({
    topics: INQUIRY_TOPICS.map((topic) => ({
      code: topic.code,
      label: topic.label,
    })),
  });
});

/**
 * GET /api/be7a41c9/stats — network stats surfaced on the corporate site
 */
router.get('/api/be7a41c9/stats', (_req, res) => {
  res.json({ stats: NETWORK_STATS });
});

/**
 * POST /api/be7a41c9/inquiry — submit a rep inquiry
 */
router.post('/api/be7a41c9/inquiry', async (req, res) => {
  try {
    const confirmation = await submitInquiry({
      topic: req.body.topic || 'digital-procurement',
      company: req.body.company || '',
      name: req.body.name || '',
      email: req.body.email || '',
      message: req.body.message || '',
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(confirmation);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'INQUIRY_ROUTING_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
