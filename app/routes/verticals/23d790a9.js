const express = require('express');
const router = express.Router();
const logger = require('../../telemetry/logger');
const pif = require('../../services/verticals/23d790a9');

const BASE = '/api/23d790a9';

router.post(`${BASE}/access`, async (req, res) => {
  // nginx appends the real client address, so the last entry is the one a caller cannot forge.
  const ip = String(req.headers['x-forwarded-for'] || req.ip || 'unknown').split(',').pop().trim();
  if (!pif.unlockAllowed(ip)) return res.status(429).json({ ok: false, error: 'Too many attempts. Please wait a minute.' });
  if (!(await pif.codeMatches(req.body && req.body.code))) return res.status(401).json({ ok: false, error: 'Incorrect access code.' });
  res.cookie(pif.ACCESS_COOKIE, pif.accessToken(), { httpOnly: true, sameSite: 'lax', secure: req.secure || req.headers['x-forwarded-proto'] === 'https', maxAge: 30 * 24 * 60 * 60 * 1000, path: '/' });
  return res.json({ ok: true });
});

router.get(`${BASE}/access`, (req, res) => res.json({ ok: pif.hasAccess(req.headers.cookie) }));

router.use(BASE, (req, res, next) => {
  if (pif.hasAccess(req.headers.cookie)) return next();
  return res.status(401).json({ ok: false, error: 'Access code required.' });
});

const wrap = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (error) {
    if (!error.status) logger.error('PIF PoC request failed', { path: req.path, error: error.message });
    res.status(error.status || 500).json({ ok: false, error: error.status ? error.message : 'Something went wrong. Please try again.' });
  }
};

router.get(`${BASE}/status`, wrap(() => pif.status()));
router.get(`${BASE}/outlook`, wrap(() => pif.outlook()));
router.get(`${BASE}/escalation`, wrap((req) => pif.escalation(req.query.lang)));
router.get(`${BASE}/library`, wrap(() => ({ documents: pif.libraryIndex(), themes: pif.THEMES, coverage: pif.coverage(), gaps: pif.researchGaps(null) })));
router.get(`${BASE}/search`, wrap((req) => ({ results: pif.search(req.query.q, 8) })));
router.post(`${BASE}/ask`, wrap((req) => pif.ask(req.body && req.body.question, { lang: req.body && req.body.lang })));
router.get(`${BASE}/trends`, wrap((req) => ({ trends: pif.rankTrends(req.query.ecosystem) })));
router.get(`${BASE}/trends/brief`, wrap((req) => pif.trendsBrief(req.query.ecosystem, req.query.lang)));
router.get(`${BASE}/figures`, wrap(() => ({ figures: pif.PUBLIC_FIGURES })));
router.post(`${BASE}/comms/check`, wrap((req) => pif.checkCommunication(req.body && req.body.text)));
router.get(`${BASE}/feature-requests`, wrap(() => pif.listFeatureRequests()));
router.post(`${BASE}/feature-requests`, wrap((req) => pif.createFeatureRequest(req.body || {})));
router.get(`${BASE}/feature-requests/:id`, wrap(async (req) => {
  const r = await pif.getFeatureRequest(req.params.id);
  if (!r) { const err = new Error('Request not found'); err.status = 404; throw err; }
  return r;
}));

module.exports = router;
