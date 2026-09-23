const express = require('express');
const path = require('path');
const { signIn } = require('../../services/verticals/login');

const router = express.Router();

router.get('/login', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', 'login.html'));
});

router.post('/api/login/signin', async (req, res) => {
  const body = req.body || {};

  try {
    const result = await signIn({
      username: body.username,
      password: body.password,
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
      code: error.code || 'SIGNIN_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
