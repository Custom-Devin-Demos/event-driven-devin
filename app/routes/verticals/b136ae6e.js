const express = require('express');
const { filterResources, RESOURCES, CONTENT_TYPES } = require('../../services/verticals/b136ae6e');

const router = express.Router();

router.get('/api/b136ae6e/resources', (_req, res) => {
  const topics = [...new Set(RESOURCES.flatMap((r) => r.topics))].sort();
  const roles = [...new Set(RESOURCES.flatMap((r) => r.roles))].sort();
  res.json({ resources: RESOURCES, contentTypes: CONTENT_TYPES, topics, roles });
});

router.post('/api/b136ae6e/filter', async (req, res) => {
  try {
    const result = await filterResources({
      contentType: req.body.contentType || '',
      topics: req.body.topics || [],
      roles: req.body.roles || [],
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
      code: error.code || 'FILTER_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
