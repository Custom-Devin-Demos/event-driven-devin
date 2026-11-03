const express = require('express');
const { submitPriorAuth, MEMBERS, PROCEDURES } = require('../../services/verticals/fe64010d');

const router = express.Router();

router.get('/api/fe64010d/context', (_req, res) => {
  res.json({ members: MEMBERS, procedures: PROCEDURES });
});

router.post('/api/fe64010d/prior-auth', async (req, res) => {
  try {
    res.json(await submitPriorAuth(req.body || {}));
  } catch (error) {
    res.status(error.name === 'ValidationError' ? 400 : 500).json({
      success: false, error: error.message, errorClass: error.name,
      code: error.name === 'ValidationError' ? 'INVALID_REQUEST' : 'PRIOR_AUTH_FAILED', requestId: req.requestId,
    });
  }
});

module.exports = router;
