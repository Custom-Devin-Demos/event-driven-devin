const express = require('express');
const path = require('path');
const {
  APP_SERVICE,
  APP_WEB_PATH,
  isAppReport,
  reportAppFailure,
} = require('../../services/verticals/9bfabd45');

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

module.exports = router;
