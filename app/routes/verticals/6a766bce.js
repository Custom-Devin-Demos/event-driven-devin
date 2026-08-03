const express = require('express');
const path = require('path');
const { filterProjects } = require('../../services/verticals/6a766bce');

const router = express.Router();

router.get('/6a766bce', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', '6a766bce.html'));
});

router.post('/api/6a766bce/filter', async (req, res) => {
  try {
    const result = await filterProjects(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'PROJECT_FILTER_FAILED',
    });
  }
});

module.exports = router;
