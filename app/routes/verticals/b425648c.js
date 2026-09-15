const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  APP_SERVICE,
  APP_WEB_PATH,
  isAppReport,
  isAppSource,
  reportAppFailure,
  registerOutageReport,
} = require('../../services/verticals/b425648c');

const router = express.Router();

const ERROR_PATH = '/api/b425648c/mobile/error';
const REPORT_PATH = '/api/b425648c/outage/report';

// Hosted `flutter build web --base-href /b425648c/app/` output: fpl.com
// My Account on desktop web (and the FPL Mobile App layout at narrow widths).
// Android/iOS builds of the same commit run natively and only hit the API
// routes below. The landing page at /b425648c (b425648c.html, aliases /fpl
// and /nextera) links here.
const APP_WEB_DIR = path.join(__dirname, '..', '..', 'public', 'verticals', 'b425648c-app');

// Flutter web output is not content-hashed (main.dart.js keeps its name across
// builds) and the CDN rewrites Cache-Control on .js to a 4h browser TTL, so
// the two entry scripts are served with a per-build query string derived from
// the compiled bundle: index.html -> flutter_bootstrap.js?v=<hash> ->
// main.dart.js?v=<hash>. index.html is HTML (never edge-cached) and is sent
// no-cache, so a deploy is picked up on the next reload.
const NO_CACHE = 'no-cache';
const APP_BUILD_ID = crypto
  .createHash('sha256')
  .update(fs.readFileSync(path.join(APP_WEB_DIR, 'main.dart.js')))
  .digest('hex')
  .slice(0, 12);
const APP_INDEX_HTML = fs
  .readFileSync(path.join(APP_WEB_DIR, 'index.html'), 'utf8')
  .replace('src="flutter_bootstrap.js"', `src="flutter_bootstrap.js?v=${APP_BUILD_ID}"`);
const APP_BOOTSTRAP_JS = fs
  .readFileSync(path.join(APP_WEB_DIR, 'flutter_bootstrap.js'), 'utf8')
  .replace('"mainJsPath":"main.dart.js"', `"mainJsPath":"main.dart.js?v=${APP_BUILD_ID}"`);

function sendIndex(res) {
  res.set('Cache-Control', NO_CACHE).type('html').send(APP_INDEX_HTML);
}

router.get([APP_WEB_PATH, `${APP_WEB_PATH}/index.html`], (req, res) => {
  if (req.path === APP_WEB_PATH) return res.redirect(301, `${APP_WEB_PATH}/`);
  return sendIndex(res);
});
router.get(`${APP_WEB_PATH}/flutter_bootstrap.js`, (_req, res) => {
  res.set('Cache-Control', NO_CACHE).type('application/javascript').send(APP_BOOTSTRAP_JS);
});
router.use(APP_WEB_PATH, express.static(APP_WEB_DIR, {
  index: false,
  setHeaders: (res) => res.set('Cache-Control', NO_CACHE),
}));
router.get(`${APP_WEB_PATH}/{*splat}`, (_req, res) => sendIndex(res));

// Friendly entry points straight into the app.
for (const entry of ['/fpl-app', '/fplapp', '/fpl/my-account']) {
  router.get(entry, (_req, res) => res.redirect(`${APP_WEB_PATH}/`));
}

// Native builds run from their own origin and skip CORS; a `flutter run -d
// chrome` dev build pointed at this host does preflight the JSON POST.
function allowCrossOrigin(req, res, next) {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-fpl-my-account-client',
    'Access-Control-Max-Age': '600',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
}

router.options(ERROR_PATH, allowCrossOrigin);
router.options(REPORT_PATH, allowCrossOrigin);

/**
 * POST /api/b425648c/outage/report — an outage ticket the FPL client built
 * on-device (service point, problem, crew, restoration window). Registration
 * only; nothing is alerted.
 */
router.post(REPORT_PATH, allowCrossOrigin, (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (!isAppSource(body)) {
    return res.status(400).json({
      success: false,
      error: 'Expected an fpl-my-account/<platform> source',
    });
  }
  if (!body.accountNumber || !body.problem) {
    return res.status(400).json({
      success: false,
      error: 'An outage report needs accountNumber and problem',
    });
  }
  return res.status(200).json(registerOutageReport(body));
});

/**
 * POST /api/b425648c/mobile/error — failure reported by the FPL Flutter app
 * (github.com/Custom-Devin-Demos/fpl-my-account-demo-app) on web, Android or
 * iOS after Report an Outage threw. Raises the Slack alert and Devin session
 * under the app identity (customer-b425648c-mobile) with the identity the
 * client carried from the hub (devinUserId / devinOrgId / devinEmail).
 */
router.post(ERROR_PATH, allowCrossOrigin, (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  if (!isAppReport(body)) {
    return res.status(400).json({
      received: false,
      error: `Expected an fpl-my-account/<platform> source with service ${APP_SERVICE}`,
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
