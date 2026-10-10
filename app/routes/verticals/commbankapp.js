const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const router = express.Router();

// Hosted `flutter build web --base-href /commbankapp/` output of the CommBank
// Flutter app (github.com/COG-GTM/event-driven-ios, CommBankApp/). The same
// Dart codebase runs natively on the iOS simulator for remediation; both
// builds report Pay now failures to POST /api/cba/ios/error (routes/cba.js),
// so this module only serves the static web build.
const APP_WEB_PATH = '/commbankapp';
const APP_WEB_DIR = path.join(__dirname, '..', '..', 'public', 'verticals', 'commbankapp-app');

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
for (const entry of ['/commbank-app', '/cba-app', '/cba/app', '/commbank/app']) {
  router.get(entry, (_req, res) => res.redirect(`${APP_WEB_PATH}/`));
}

module.exports = router;
module.exports.APP_WEB_PATH = APP_WEB_PATH;
module.exports.APP_WEB_DIR = APP_WEB_DIR;
