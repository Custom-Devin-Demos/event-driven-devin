const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  APP_SERVICE: IOS_APP_SERVICE,
  APP_SOURCE_PREFIX: IOS_APP_SOURCE_PREFIX,
  IOS_ERROR_PATH,
  isAppReport: isIosAppReport,
  reportAppFailure: reportIosAppFailure,
} = require('../../services/verticals/commbiz-ios');

const router = express.Router();

// CommBiz app report bridge (github.com/COG-GTM/event-driven-ios, CommBizApp/):
// the Flutter app (web build hosted below, also iOS) POSTs its platform
// failures here and this host bridges them to Sentry, Slack and a Devin session.
function allowCrossOrigin(req, res, next) {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, User-Agent',
    'Access-Control-Max-Age': '600',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
}

router.options(IOS_ERROR_PATH, allowCrossOrigin);

const parsedMax = parseInt(process.env.REPORT_CAP_COMMBIZ_IOS_MAX, 10);
const REPORT_MAX = Number.isNaN(parsedMax) ? 10 : parsedMax;
const parsedWindow = parseInt(process.env.REPORT_CAP_COMMBIZ_IOS_WINDOW_MINUTES, 10);
const REPORT_WINDOW_MS = (Number.isNaN(parsedWindow) ? 10 : parsedWindow) * 60 * 1000;
const acceptedAt = [];

function reserveReportSlot(now = Date.now()) {
  const cutoff = now - REPORT_WINDOW_MS;
  while (acceptedAt.length > 0 && acceptedAt[0] < cutoff) acceptedAt.shift();
  if (acceptedAt.length >= REPORT_MAX) return false;
  acceptedAt.push(now);
  return true;
}

// Seconds until the oldest accepted report ages out of the window and frees a slot.
function retryAfterSeconds(now = Date.now()) {
  if (acceptedAt.length === 0) return 1;
  const remainingMs = acceptedAt[0] + REPORT_WINDOW_MS - now;
  return Math.max(1, Math.ceil(remainingMs / 1000));
}

router.post(IOS_ERROR_PATH, allowCrossOrigin, (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  if (!isIosAppReport(body)) {
    return res.status(400).json({
      received: false,
      status: 'rejected',
      error: `Expected a ${IOS_APP_SOURCE_PREFIX}<platform> source with service ${IOS_APP_SERVICE}`,
    });
  }

  if (!reserveReportSlot()) {
    res.set('Retry-After', String(retryAfterSeconds()));
    return res.status(429).json({
      received: false,
      status: 'throttled',
      error: `Report cap reached for ${IOS_APP_SERVICE}; retry later`,
    });
  }

  const { reference } = reportIosAppFailure(body);

  return res.status(202).json({
    received: true,
    status: 'accepted',
    reference,
    service: IOS_APP_SERVICE,
    sessionRequested: true,
    receivedAt: new Date().toISOString(),
  });
});

// Hosted `flutter build web --base-href /commbizapp/` output of the CommBiz
// Flutter app. The same Dart codebase runs natively on the iOS simulator; the
// web build reports to the origin it is served from, i.e. the route above.
const APP_WEB_PATH = '/commbizapp';
const APP_WEB_DIR = path.join(__dirname, '..', '..', 'public', 'verticals', 'commbizapp-app');

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
for (const entry of ['/commbiz', '/commbiz-app', '/commbiz/app']) {
  router.get(entry, (_req, res) => res.redirect(`${APP_WEB_PATH}/`));
}

module.exports = router;
module.exports.APP_WEB_PATH = APP_WEB_PATH;
module.exports.APP_WEB_DIR = APP_WEB_DIR;
module.exports.reserveReportSlot = reserveReportSlot;
module.exports.retryAfterSeconds = retryAfterSeconds;
