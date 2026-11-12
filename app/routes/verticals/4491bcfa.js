const express = require('express');
const {
  getProfile,
  getPlatforms,
  getSecurity,
  getPortalSession,
} = require('../../services/verticals/4491bcfa');

const router = express.Router();

const ACCOUNT_ID_RE = /^EA-[0-9]{4,10}$/;
const SESSION_RE = /^[A-Za-z0-9_]{1,64}$/;

function readSession(req) {
  const header = req.get('x-ea-session');
  const raw = (typeof header === 'string' && header) || (typeof req.query.session === 'string' ? req.query.session : '');
  return SESSION_RE.test(raw) ? raw : '';
}

function identity(req) {
  const body = req.body || {};
  const q = req.query || {};
  return {
    devinUserId: body.devinUserId || q.devinUserId || '',
    devinOrgId: body.devinOrgId || q.devinOrgId || '',
    devinEmail: body.devinEmail || q.devinEmail || '',
  };
}

function handle(req, res, fn) {
  const accountId = req.params.accountId;
  if (!ACCOUNT_ID_RE.test(accountId)) {
    return res.status(400).json({ success: false, error: 'Invalid account id', code: 'INVALID_ACCOUNT_ID' });
  }
  try {
    const result = fn({ accountId, sessionId: readSession(req), ...identity(req) });
    return res.json(result);
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      code: error.code || 'ACCOUNT_READ_FAILED',
    });
  }
}

// Signed-in portal context for the page (synthetic demo session).
router.get('/api/4491bcfa/session', (_req, res) => {
  res.json(getPortalSession());
});

router.get('/api/accounts/:accountId/profile', (req, res) => handle(req, res, getProfile));
router.get('/api/accounts/:accountId/linked-platforms', (req, res) => handle(req, res, getPlatforms));
router.get('/api/accounts/:accountId/security', (req, res) => handle(req, res, getSecurity));

module.exports = router;
