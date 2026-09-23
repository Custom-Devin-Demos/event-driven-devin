const express = require('express');
const path = require('path');
const { signIn, getTenant } = require('../../services/verticals/d7c4a1b9');

const router = express.Router();

const PAGE = path.join(__dirname, '..', '..', 'public', 'verticals', 'd7c4a1b9.html');

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

// Every demo owner gets their own unlisted URL: /d7c4a1b9/<tenant>. The bare
// slug is served by the vertical registry but carries no tenant, so its form
// refuses to sign in rather than running against someone else's demo state.
router.get('/d7c4a1b9/:tenant', (req, res, next) => {
  if (!getTenant(req.params.tenant)) return next();
  sendPage(req, res);
});

router.post('/api/d7c4a1b9/:tenant/signin', handleSignIn);

module.exports = router;
