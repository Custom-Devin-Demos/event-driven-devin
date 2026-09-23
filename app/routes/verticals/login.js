const express = require('express');
const path = require('path');
const { signIn, getTenant } = require('../../services/verticals/login');

const router = express.Router();

const PAGE = path.join(__dirname, '..', '..', 'public', 'verticals', 'login.html');

function sendPage(_req, res) {
  res.sendFile(PAGE);
}

async function handleSignIn(req, res) {
  const body = req.body || {};

  try {
    const result = await signIn({
      tenant: req.params.tenant,
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
}

router.get('/login', sendPage);

router.get('/login/:tenant', (req, res, next) => {
  if (!getTenant(req.params.tenant)) return next();
  sendPage(req, res);
});

router.post('/api/login/signin', handleSignIn);
router.post('/api/login/:tenant/signin', handleSignIn);

module.exports = router;
