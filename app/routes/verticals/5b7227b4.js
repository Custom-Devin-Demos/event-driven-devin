const express = require('express');
const path = require('path');
const {
  APP_SERVICE,
  APP_WEB_PATH,
  isAppReport,
  isAppSource,
  reportAppFailure,
  registerBag,
} = require('../../services/verticals/5b7227b4');

const router = express.Router();

const ERROR_PATH = '/api/5b7227b4/mobile/error';
const BAG_PATH = '/api/5b7227b4/bag';

// Hosted `flutter build web --base-href /5b7227b4/app/` output: the
// nordstrom.com desktop site (and the phone layout at narrow widths).
// Android/iOS builds of the same commit run natively and only hit the API
// routes below.
const APP_WEB_DIR = path.join(__dirname, '..', '..', 'public', 'verticals', '5b7227b4-app');

router.use(APP_WEB_PATH, express.static(APP_WEB_DIR, { index: 'index.html' }));
router.get(`${APP_WEB_PATH}/{*splat}`, (_req, res) => {
  res.sendFile(path.join(APP_WEB_DIR, 'index.html'));
});

// Friendly entry points (there is no <slug>.html page for this vertical).
for (const entry of ['/5b7227b4', '/nordstromapp', '/nordstrom-app']) {
  router.get(entry, (_req, res) => res.redirect(`${APP_WEB_PATH}/`));
}

// Native builds run from their own origin and skip CORS; a `flutter run -d
// chrome` dev build pointed at this host does preflight the JSON POST.
function allowCrossOrigin(req, res, next) {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-nordstrom-shop-client',
    'Access-Control-Max-Age': '600',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
}

router.options(ERROR_PATH, allowCrossOrigin);
router.options(BAG_PATH, allowCrossOrigin);

/**
 * POST /api/5b7227b4/bag — a bag the Nordstrom client priced on-device.
 * Registration only; nothing is alerted.
 */
router.post(BAG_PATH, allowCrossOrigin, (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (!isAppSource(body)) {
    return res.status(400).json({
      success: false,
      error: 'Expected a nordstrom-shop/<platform> source',
    });
  }
  return res.status(200).json(registerBag(body));
});

/**
 * POST /api/5b7227b4/mobile/error — failure reported by the Nordstrom Flutter
 * app (github.com/Custom-Devin-Demos/nordstrom-shopping-demo-app) on web,
 * Android or iOS after a user action threw. Raises the Slack alert and Devin
 * session under the app identity (customer-5b7227b4-mobile) with the identity
 * the client carried from the hub (devinUserId / devinOrgId / devinEmail).
 */
router.post(ERROR_PATH, allowCrossOrigin, (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  if (!isAppReport(body)) {
    return res.status(400).json({
      received: false,
      error: `Expected a nordstrom-shop/<platform> source with service ${APP_SERVICE}`,
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
