const express = require('express');
const { submitInquiry, INQUIRY_TOPICS, BRANDS } = require('../../services/verticals/0e015eed');

const router = express.Router();

/**
 * GET /api/0e015eed/topics — inquiry topics offered on the contact form
 */
router.get('/api/0e015eed/topics', (_req, res) => {
  res.json({
    topics: INQUIRY_TOPICS.map((topic) => ({
      code: topic.code,
      label: topic.label,
    })),
  });
});

/**
 * GET /api/0e015eed/brands — brand portfolio metadata
 */
router.get('/api/0e015eed/brands', (_req, res) => {
  res.json({ brands: BRANDS });
});

/**
 * POST /api/0e015eed/inquiry — submit a corporate inquiry
 */
router.post('/api/0e015eed/inquiry', async (req, res) => {
  try {
    const confirmation = await submitInquiry({
      topic: req.body.topic || 'brand-partnerships',
      brand: req.body.brand || '',
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
