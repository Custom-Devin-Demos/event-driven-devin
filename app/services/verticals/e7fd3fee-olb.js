const express = require('express');
const path = require('path');
const fs = require('fs');

const OLB_DIR = path.join(__dirname, '..', '..', 'public', 'verticals', 'e7fd3fee-olb');
const OLB_BASE = '/e7fd3fee/olb';
const olbForm = express.urlencoded({ extended: false });

/**
 * The static Online Banking replica (snapshots of COG-GTM/boa-web-app) mounted
 * at basePath. decorate(html), when given, rewrites each page before it is sent.
 */
function createOlbRouter(basePath = OLB_BASE, decorate = null) {
  const router = express.Router();
  router.get(basePath, (_req, res) => res.redirect(`${basePath}/login`));
  router.use(`${basePath}/assets`, express.static(path.join(OLB_DIR, 'assets')));
  router.get(`${basePath}/keepalive`, (_req, res) => res.status(204).end());
  router.get(`${basePath}/account-reveal`, (_req, res) => res.status(403).json({ error: 'Full account numbers are hidden in this demo.' }));

  router.post(`${basePath}/login`, olbForm, (req, res) => {
    const body = req.body || {};
    res.redirect(303, body.passcode ? `${basePath}/verify` : `${basePath}/login-passcode`);
  });
  router.post(`${basePath}/verify`, olbForm, (_req, res) => res.redirect(303, `${basePath}/accounts`));

  router.get(`${basePath}/:page`, (req, res, next) => {
    const page = String(req.params.page).replace(/[^a-z0-9_-]/gi, '');
    const file = path.join(OLB_DIR, `${page}.html`);
    if (!fs.existsSync(file)) {
      res.redirect(`${basePath}/accounts`);
      return;
    }
    if (!decorate) {
      res.sendFile(file);
      return;
    }
    fs.readFile(file, 'utf8', (err, html) => {
      if (err) return next(err);
      return res.type('html').send(decorate(html));
    });
  });
  router.post(`${basePath}/:page`, olbForm, (req, res) => {
    res.redirect(303, `${basePath}/${String(req.params.page).replace(/[^a-z0-9_-]/gi, '')}`);
  });
  return router;
}

/** Point a page's Online Banking links at another mount of the replica. */
function rebaseOlbLinks(html, basePath) {
  return html.split(OLB_BASE).join(basePath);
}

module.exports = { createOlbRouter, rebaseOlbLinks, OLB_BASE };
