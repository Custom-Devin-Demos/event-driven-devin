const express = require('express');
const path = require('path');
const { ROUTE, APP_WEB_PATH, loadIndexDetail } = require('../../services/verticals/c28a3fe9');

const router = express.Router();

// Hosted `vite build --base=/c28a3fe9/app/` output of the Market Monitor
// (github.com/rdf004/s-and-p-event-driven-demo).
const APP_WEB_DIR = path.join(__dirname, '..', '..', 'public', 'verticals', 'c28a3fe9-app');

router.use(APP_WEB_PATH, express.static(APP_WEB_DIR, { index: 'index.html' }));
router.get(`${APP_WEB_PATH}/{*splat}`, (_req, res) => {
  res.sendFile(path.join(APP_WEB_DIR, 'index.html'));
});

// Friendly entry points (there is no <slug>.html page for this vertical).
for (const entry of ['/c28a3fe9', '/capitaliq', '/capital-iq']) {
  router.get(entry, (_req, res) => res.redirect(`${APP_WEB_PATH}/`));
}

router.post(ROUTE, async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    res.json(await loadIndexDetail(body));
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'INDEX_DETAIL_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;
