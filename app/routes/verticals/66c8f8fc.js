const express = require('express');
const { login, resumeSession, getAccount, logout } = require('../../services/verticals/66c8f8fc');

const router = express.Router();

function handle(fn) {
  return (req, res) => {
    try {
      res.json(fn(req));
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message, code: error.code || 'ERROR' });
    }
  };
}

const bearer = (req) => (req.get('authorization') || '').replace(/^Bearer\s+/i, '');

router.post('/api/66c8f8fc/login', handle((req) => login(req.body || {})));
router.post('/api/66c8f8fc/session/resume', handle((req) => resumeSession(req.body || {})));
router.get('/api/66c8f8fc/account', handle((req) => getAccount(bearer(req))));
router.post('/api/66c8f8fc/logout', handle((req) => logout({ sessionToken: bearer(req), token: (req.body || {}).token })));

module.exports = router;
