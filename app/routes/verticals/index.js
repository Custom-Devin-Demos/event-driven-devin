const express = require('express');
const fs = require('fs');
const path = require('path');
const { listAliases } = require('../../../config/customers');
const logger = require('../../telemetry/logger');

const router = express.Router();

const ROUTES_DIR = __dirname;
const PAGES_DIR = path.join(__dirname, '..', '..', 'public', 'verticals');

/**
 * Vertical registration is discovered from the filesystem so that adding a
 * vertical never edits this file:
 *
 *   app/routes/verticals/<id>.js      — API router, mounted automatically
 *   app/public/verticals/<id>.html    — page, served at /<id>
 *   config/customers/<id>.js          — Devin config + optional `aliases`
 *                                       (friendly URLs that serve <id>.html)
 *
 * Route modules are mounted before pages, so a module may take over its own
 * /<id> path (e.g. qbe.js) and no two modules may register the same path.
 * Aliases are registered before pages, so an alias always wins over a page of
 * the same name.
 *
 * Registry problems (a module that fails to load, an alias whose target page
 * is missing) are logged and skipped rather than thrown: the deployed tree can
 * contain files the repo no longer has, and a stale file must never take the
 * whole app down. tests/verticals-registry.test.js enforces a clean registry
 * on the committed tree.
 */

/** Ids of every route module in this directory (sorted, excluding index.js). */
function discoverRouteIds() {
  return fs.readdirSync(ROUTES_DIR)
    .filter((file) => file.endsWith('.js') && file !== 'index.js')
    .map((file) => file.slice(0, -3))
    .sort();
}

/** Ids of every page in app/public/verticals (sorted). */
function discoverPageIds() {
  return fs.readdirSync(PAGES_DIR)
    .filter((file) => file.endsWith('.html'))
    .map((file) => file.slice(0, -5))
    .sort();
}

function sendPage(id) {
  return (_req, res) => {
    res.sendFile(path.join(PAGES_DIR, `${id}.html`));
  };
}

// Mount API routes for each vertical
const routeIds = [];
const skippedRouteIds = [];
for (const id of discoverRouteIds()) {
  let mod;
  try {
    mod = require(path.join(ROUTES_DIR, `${id}.js`));
  } catch (err) {
    logger.error('Vertical route module failed to load; skipping', { id, error: err.message });
    skippedRouteIds.push(id);
    continue;
  }
  if (typeof mod !== 'function') {
    logger.error('Vertical route module must export an express Router; skipping', { id });
    skippedRouteIds.push(id);
    continue;
  }
  router.use(mod);
  routeIds.push(id);
}

/**
 * Vertical metadata for the landing page hub. Customer demos are deliberately
 * not listed here: the hub is on screen during demos, so they are reachable
 * only by direct URL.
 */
const VERTICALS = [
  { id: 'retail', name: 'Retail eCommerce', brand: 'ACME Commerce', path: '/retail', icon: '\u{1F6D2}', color: '#c8a97e' },
  { id: 'banking', name: 'Banking', brand: 'Apex Bank', path: '/banking', icon: '\u{1F3E6}', color: '#2E86AB' },
  { id: 'financial-services', name: 'Financial Services', brand: 'Meridian Capital', path: '/financial-services', icon: '\u{1F4C8}', color: '#1B998B' },
  { id: 'insurance', name: 'Insurance', brand: 'Shield Insurance', path: '/insurance', icon: '\u{1F6E1}', color: '#E84855' },
  { id: 'cpg', name: 'CPG', brand: 'Harvest Goods', path: '/cpg', icon: '\u{1F4E6}', color: '#F18F01' },
  { id: 'hightech', name: 'High Tech', brand: 'NovaSoft', path: '/hightech', icon: '\u{1F4BB}', color: '#7B2CBF' },
  { id: 'industrials', name: 'Industrials', brand: 'Titan Manufacturing', path: '/industrials', icon: '\u{1F3ED}', color: '#6C757D' },
  { id: 'healthcare', name: 'Health Care', brand: 'CarePoint Health', path: '/healthcare', icon: '\u{1F3E5}', color: '#06D6A0' },
  { id: 'telco', name: 'Telco', brand: 'WaveConnect', path: '/telco', icon: '\u{1F4F1}', color: '#118AB2' },
];

/**
 * GET /api/verticals — returns all available verticals
 */
router.get('/api/verticals', (_req, res) => {
  res.json({ verticals: VERTICALS });
});

const pageIds = discoverPageIds();

// Friendly public URLs declared in config/customers/<slug>.js (e.g. /publix → 4c351052.html)
const aliases = {};
for (const [alias, id] of Object.entries(listAliases())) {
  if (!pageIds.includes(id)) {
    logger.error('Alias points at a missing page; skipping', { alias, id });
    continue;
  }
  if (pageIds.includes(alias)) {
    logger.warn('Alias shadows a page of the same name; alias wins', { alias, id });
  }
  router.get(`/${alias}`, sendPage(id));
  aliases[alias] = id;
}

// Serve every vertical page at its own clean URL: /banking, /insurance, /<slug>, ...
for (const id of pageIds) {
  router.get(`/${id}`, sendPage(id));
}

// Retail uses the existing index.html at /retail
router.get('/retail', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'index.html'));
});

// Landing page hub — shows all verticals with easy-to-reach URLs
router.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'hub.html'));
});

module.exports = router;
module.exports.VERTICALS = VERTICALS;
module.exports.routeIds = routeIds;
module.exports.skippedRouteIds = skippedRouteIds;
module.exports.pageIds = pageIds;
module.exports.aliases = aliases;
