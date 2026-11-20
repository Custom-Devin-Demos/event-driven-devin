const express = require('express');
const path = require('path');
const {
  APP_SERVICE,
  APP_WEB_PATH,
  isAppReport,
  reportAppFailure,
} = require('../../services/verticals/9bfabd45');
const { startPdlcRun, stopPdlcRun, getPdlcState } = require('../../services/verticals/9bfabd45-pdlc');

const router = express.Router();

const ERROR_PATH = '/api/9bfabd45/error';

// Hosted `npm run build --base=/9bfabd45/app/` output of the NEXEN frontend
// (github.com/COG-GTM/bny), running its in-browser mock client.
const APP_WEB_DIR = path.join(__dirname, '..', '..', 'public', 'verticals', '9bfabd45-app');

router.use(APP_WEB_PATH, express.static(APP_WEB_DIR, { index: 'index.html' }));
router.get(`${APP_WEB_PATH}/{*splat}`, (_req, res) => {
  res.sendFile(path.join(APP_WEB_DIR, 'index.html'));
});

// Friendly entry points (there is no <slug>.html page for this vertical).
for (const entry of ['/9bfabd45', '/bny', '/nexen']) {
  router.get(entry, (_req, res) => res.redirect(`${APP_WEB_PATH}/`));
}

// A `npm run dev` build pointed at this host preflights the JSON POST.
function allowCrossOrigin(req, res, next) {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
}

router.options(ERROR_PATH, allowCrossOrigin);

/**
 * POST /api/9bfabd45/error — failure reported by the NEXEN frontend
 * (github.com/COG-GTM/bny) after a user action threw. Raises the Slack alert
 * and Devin session under the app identity (customer-9bfabd45-web).
 */
router.post(ERROR_PATH, allowCrossOrigin, (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  if (!isAppReport(body)) {
    return res.status(400).json({
      received: false,
      error: `Expected a nexen-custody/<platform> source with service ${APP_SERVICE}`,
    });
  }

  const { reference } = reportAppFailure(body);

  return res.status(202).json({
    received: true,
    reference,
    service: APP_SERVICE,
    sessionRequested: true,
    receivedAt: new Date().toISOString(),
  });
});

// BNY demo 1 (PDLC): personas discuss price alerts on Holdings in
// #pershing-access-product and the Android Engineer Bot joins unprompted.
const PDLC_PAGE = path.join(__dirname, '..', '..', 'public', 'verticals', '9bfabd45-pdlc.html');
for (const entry of ['/9bfabd45/pdlc', '/bny-pdlc']) {
  router.get(entry, (_req, res) => res.sendFile(PDLC_PAGE));
}

function pdlcKeyOk(req) {
  const key = process.env.BNY_PDLC_TRIGGER_KEY;
  return !key || req.get('x-demo-key') === key || (req.body && req.body.key === key);
}

router.get('/api/9bfabd45/pdlc/state', (_req, res) => res.json(getPdlcState()));

router.post('/api/9bfabd45/pdlc/run', (req, res) => {
  if (!pdlcKeyOk(req)) return res.status(403).json({ started: false, reason: 'bad_key' });
  const { started, reason, state } = startPdlcRun({
    triggeredBy: req.get('x-demo-user') || 'web',
    kickoff: req.body && req.body.kickoff === 'person' ? 'person' : 'persona',
  });
  return res.status(started ? 202 : 409).json({ started, reason: reason || null, state });
});

router.post('/api/9bfabd45/pdlc/stop', (req, res) => {
  if (!pdlcKeyOk(req)) return res.status(403).json({ stopped: false, reason: 'bad_key' });
  return res.json({ stopped: true, state: stopPdlcRun() });
});

module.exports = router;
