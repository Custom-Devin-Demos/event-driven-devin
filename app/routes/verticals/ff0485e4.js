const express = require('express');
const { submitPriorAuth, MEMBERS, PROCEDURES } = require('../../services/verticals/ff0485e4');

const router = express.Router();

router.get('/api/ff0485e4/context', (_req, res) => {
  res.json({ members: MEMBERS, procedures: PROCEDURES });
});

router.post('/api/ff0485e4/prior-auth', async (req, res) => {
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
