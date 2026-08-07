const express = require('express');
const path = require('path');
const fs = require('fs');
const logger = require('../telemetry/logger');
const {
  ALERT_SCENARIOS,
  BUG_REPORTS,
  BUG_CATALOG,
  postOncallAlert,
  postOncallBugReport,
  INFRA_INCIDENTS,
  postOncallInfraIncident,
  getInfraState,
  postOncallIncident,
  SEV1_INCIDENTS,
  getSev1State,
} = require('../services/oncall');
const { getOncallSkin, ONCALL_SKINS } = require('../../config/oncall-skins');

const router = express.Router();

/**
 * Tag the caller's browser with the run's degradation cookie: only requests
 * carrying it see that run's live symptoms (see the scoping middleware in
 * server.js), so a demo never degrades the site for anyone else.
 */
function setRunCookie(res, runRef, windowMinutes) {
  if (!runRef) return;
  // Outlives the degradation window by a grace period so the page can still
  // show the terminal state (resolved / auto-resolve failed) after it ends.
  res.cookie('oncall_run', runRef, {
    path: '/',
    maxAge: ((windowMinutes || 30) + 15) * 60000,
    sameSite: 'lax',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
  });
}

// Startup check: every skin template id must resolve in the shared BUG_CATALOG,
// otherwise its backend-symptom repro mapping silently does nothing.
const KNOWN_TEMPLATE_IDS = new Set(
  Object.values(BUG_CATALOG).flatMap((entries) => entries.map((t) => t.id))
);
for (const skin of Object.values(ONCALL_SKINS)) {
  if (!ALERT_SCENARIOS[skin.vertical]) {
    logger.warn('On-Call skin references unknown vertical', {
      skin: skin.slug,
      vertical: skin.vertical,
    });
  }
  const products = (skin.bugPortal && skin.bugPortal.products) || [];
  for (const product of products) {
    for (const template of product.templates || []) {
      if (!KNOWN_TEMPLATE_IDS.has(template.id)) {
        logger.warn('On-Call skin references unknown bug template id', {
          skin: skin.slug,
          templateId: template.id,
        });
      }
    }
  }
}

/**
 * Serialize a value as a JS literal safe for embedding in an inline <script>.
 */
function jsLiteral(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Serve an on-call page with a customer skin injected as window.ONCALL_SKIN.
 * The pages apply the skin client-side (branding, copy, portal products);
 * all mechanics stay shared code.
 */
function sendSkinnedPage(res, next, page, skin) {
  const pagePath = path.join(__dirname, '..', 'public', page);
  fs.readFile(pagePath, 'utf8', (err, html) => {
    if (err) return next(err);
    const inject = `<script>window.ONCALL_SKIN = ${jsLiteral(skin)};</script>`;
    res.type('html').send(html.replace('</head>', () => `${inject}\n</head>`));
  });
}

/**
 * Rebrand a served vertical page with a skin's company name, mark, title,
 * and theme variables, and hide the demo-hub back link. Applied on top of
 * the on-call shim so the shared URL looks like the customer's own product.
 */
function buildSkinBrandShim(skin) {
  const page = skin.page || {};
  const themeVars = Object.entries(page.theme || {})
    .filter(([k, v]) => /^--[a-z0-9-]+$/i.test(k) && /^[^<>{};]*$/.test(String(v)))
    .map(([k, v]) => `${k}: ${v};`)
    .join(' ');
  return `
  <style>:root { ${themeVars} }</style>
  <script>
    (function () {
      document.title = ${jsLiteral(page.title || skin.company)};
      var logo = document.querySelector('.logo');
      if (logo) {
        logo.textContent = '';
        var mark = document.createElement('div');
        mark.className = 'logo-mark';
        mark.textContent = ${jsLiteral(skin.brandMark || '')};
        logo.appendChild(mark);
        logo.appendChild(document.createTextNode(${jsLiteral(skin.company)}));
      }
      var back = document.querySelector('.back-link');
      if (back) back.remove();
      var disclaimer = ${jsLiteral(skin.disclaimer || '')};
      if (disclaimer) {
        var bar = document.createElement('div');
        bar.style.cssText = 'background:#fef3c7;color:#92400e;font-size:12px;font-weight:600;text-align:center;padding:8px 16px;';
        bar.textContent = disclaimer;
        document.body.insertBefore(bar, document.body.firstChild);
      }
    })();
  </script>`;
}

/**
 * GET /oncall/c/:slug — the customer's single branded demo page: the skin's
 * chosen vertical page rebranded, with the on-call shim active. This is the
 * URL a DE shares for a custom demo; the /oncall hub itself is never skinned.
 * Registered before /oncall/:vertical so "c" is never treated as a vertical.
 */
router.get('/oncall/c/:slug', (req, res, next) => {
  const skin = getOncallSkin(req.params.slug);
  if (!skin) return next();
  const scenario = ALERT_SCENARIOS[skin.vertical];
  if (!scenario) return next();
  const pagePath = path.join(__dirname, '..', 'public', 'verticals', scenario.page);
  fs.readFile(pagePath, 'utf8', (err, html) => {
    if (err) return next(err);
    res.type('html').send(
      html.replace('</body>', () => `${buildOncallShim(scenario)}\n${buildSkinBrandShim(skin)}\n</body>`)
    );
  });
});

/**
 * GET /oncall/c/:slug/report — customer-skinned support portal.
 */
router.get('/oncall/c/:slug/report', (req, res, next) => {
  const skin = getOncallSkin(req.params.slug);
  if (!skin) return next();
  sendSkinnedPage(res, next, 'oncall-report.html', skin);
});

/**
 * GET /oncall — On-Call demo control page
 */
router.get('/oncall', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'oncall.html'));
});

/**
 * GET /oncall/report — standalone customer-facing bug report page.
 * Registered before /oncall/:vertical so "report" is never treated as a vertical.
 */
router.get('/oncall/report', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'oncall-report.html'));
});

/**
 * On-call shim injected into the real branded vertical pages served at
 * /oncall/<vertical>. It reroutes the page's primary action to the on-call
 * vertical endpoint (where the on-call scenario's degradation lives) and
 * posts the alert card, so the presenter uses the genuine product UI and
 * sees the genuine symptom while the alert lands in #oncall-alerts. The
 * legacy vertical endpoints and their automated-alert pipeline are never
 * touched.
 */
function buildOncallShim(scenario) {
  return `
  <div id="oncall-ribbon" style="position:fixed;bottom:16px;right:16px;z-index:9999;background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:8px;padding:10px 14px;font-family:monospace;font-size:12px;box-shadow:0 4px 12px rgba(0,0,0,0.3);">
    <div style="font-weight:700;color:#f0f6fc;margin-bottom:4px;">Devin On-Call demo</div>
    <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
      <input type="checkbox" id="oncall-unique" checked style="accent-color:#58a6ff;">
      Unique per run
    </label>
    <div id="oncall-status" style="margin-top:6px;max-width:220px;"></div>
  </div>
  <script>
    (function () {
      const apiPath = ${JSON.stringify(scenario.apiPath)};
      const oncallApiPath = ${JSON.stringify(scenario.oncallApiPath)};
      const vertical = ${JSON.stringify(scenario.vertical)};
      const origFetch = window.fetch.bind(window);
      window.fetch = function (url, opts) {
        if (typeof url === 'string' && url.startsWith(apiPath) && (opts && opts.method && opts.method.toUpperCase() === 'POST')) {
          // Reroute the page's primary action to the on-call vertical
          // endpoint: the scenario's real degradation fires and Sentry/
          // Datadog capture genuine telemetry. The alert card is posted
          // alongside. Legacy endpoints are untouched.
          const unique = document.getElementById('oncall-unique').checked;
          origFetch('/api/oncall/trigger/' + vertical, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ unique: unique, devinEmail: localStorage.getItem('devinEmail') || '' }),
          }).then(function (r) { return r.json(); }).then(function (d) {
            const el = document.getElementById('oncall-status');
            if (d.skipped) {
              console.warn('On-call alert post skipped: ' + d.error);
              el.textContent = '';
              return;
            }
            el.style.color = d.ok ? '#3fb950' : '#f85149';
            el.textContent = d.ok ? 'Alert posted to #oncall-alerts' : (d.error || 'Alert post failed');
          }).catch(function () {});
          return origFetch(url.replace(apiPath, oncallApiPath), opts);
        }
        return origFetch(url, opts);
      };
    })();
  </script>`;
}

/**
 * GET /oncall/:vertical — real branded vertical page with the on-call shim
 */
router.get('/oncall/:vertical', (req, res, next) => {
  const scenario = ALERT_SCENARIOS[req.params.vertical];
  if (!scenario) return next();

  const pagePath = path.join(__dirname, '..', 'public', 'verticals', scenario.page);
  fs.readFile(pagePath, 'utf8', (err, html) => {
    if (err) return next(err);
    res.type('html').send(html.replace('</body>', `${buildOncallShim(scenario)}\n</body>`));
  });
});

/**
 * POST /api/oncall/trigger/:vertical — posts the on-call alert card. The
 * shimmed branded pages call this alongside the on-call vertical API, whose
 * telemetry fires normally; the legacy automated-alert pipeline is not used.
 */
router.post('/api/oncall/trigger/:vertical', async (req, res) => {
  const scenario = ALERT_SCENARIOS[req.params.vertical];
  if (!scenario) {
    return res.status(404).json({ ok: false, error: `Unknown vertical: ${req.params.vertical}` });
  }
  try {
    const { unique, devinEmail } = req.body || {};
    const result = await postOncallAlert(req.params.vertical, { unique: unique !== false, devinEmail });
    res.status(result.ok ? 200 : 400).json(result);
  } catch (error) {
    logger.error('On-Call trigger failed', { error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/oncall/scenarios — available alert scenarios + canned bug reports
 */
router.get('/api/oncall/scenarios', (_req, res) => {
  const scenarios = Object.entries(ALERT_SCENARIOS).map(([id, s]) => ({
    id,
    brand: s.brand,
    endpoint: s.endpoint,
    monitor: s.monitor,
    symptom: s.symptom,
  }));
  const bugReports = Object.entries(BUG_REPORTS).map(([id, text]) => ({ id, text }));
  const bugCatalog = Object.entries(BUG_CATALOG).map(([product, entries]) => ({
    product,
    templates: entries.map((t) => ({
      id: t.id,
      label: t.label,
      sev: t.sev,
      text: t.text,
      backend: Boolean(t.infraKind),
    })),
  }));
  res.json({ scenarios, bugReports, bugCatalog });
});

/**
 * POST /api/oncall/alert — post an alert card to #oncall-alerts
 * Body: { scenario: 'banking'|'insurance'|'hightech'|'telco', unique?: boolean }
 */
router.post('/api/oncall/alert', async (req, res) => {
  try {
    const { scenario, unique, devinEmail } = req.body || {};
    const result = await postOncallAlert(scenario, { unique: unique !== false, devinEmail });
    res.status(result.ok ? 200 : 400).json(result);
  } catch (error) {
    logger.error('On-Call alert post failed', { error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/oncall/bug — post a human-style bug report to #oncall-bugs
 * Body: { scenario?: string, templateId?: string, text?: string, reporter?: { name, email }, severity?: string, productArea?: string }
 * Backend-symptom templates (resolved server-side) also activate the matching
 * infra degradation for the standard auto-revert window so repro is genuine.
 */
router.post('/api/oncall/bug', async (req, res) => {
  try {
    const { scenario, templateId, text, reporter, severity, productArea, devinEmail, skin } = req.body || {};
    const skinConfig = getOncallSkin(skin);
    const result = await postOncallBugReport({
      scenarioId: scenario,
      templateId,
      text,
      reporter,
      severity,
      productArea,
      devinEmail,
      supportCenter: skinConfig ? skinConfig.supportCenter : undefined,
    });
    if (result.activated) setRunCookie(res, result.runRef, result.windowMinutes);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (error) {
    logger.error('On-Call bug report post failed', { error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/oncall/infra/:kind — fire an infra-style (SRE) incident:
 * activates the matching built-in scenario (auto-reverts after a window)
 * and posts a Datadog-monitor-style alert card.
 * Kinds: latency, dependency-timeout, memory-leak, slo-burn.
 */
router.post('/api/oncall/infra/:kind', async (req, res) => {
  if (!INFRA_INCIDENTS[req.params.kind]) {
    return res.status(404).json({ ok: false, error: `Unknown infra incident: ${req.params.kind}` });
  }
  try {
    const result = await postOncallInfraIncident(req.params.kind, { devinEmail: (req.body || {}).devinEmail });
    if (result.ok && result.active) setRunCookie(res, result.runRef, result.windowMinutes);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (error) {
    logger.error('On-Call infra trigger failed', { kind: req.params.kind, error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/oncall/infra/state — live state for the /oncall health strip.
 */
router.get('/api/oncall/infra/state', (_req, res) => {
  res.json(getInfraState());
});

/**
 * POST /api/oncall/latency — back-compat alias for the latency infra incident.
 */
router.post('/api/oncall/latency', async (req, res) => {
  try {
    const result = await postOncallInfraIncident('latency', { devinEmail: (req.body || {}).devinEmail });
    if (result.ok && result.active) setRunCookie(res, result.runRef, result.windowMinutes);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (error) {
    logger.error('On-Call latency trigger failed', { error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/oncall/incident — declare a SEV-1 incident.
 * Body: { kind?: 'checkout-gateway'|'db-latency'|'error-budget'|'memory-leak', devinEmail?: string }
 * Activates the matching real degradation, declares a Datadog incident
 * (Datadog creates the Slack incident channel), invites Devin + the DE,
 * and auto-resolves when the degradation window ends.
 */
router.post('/api/oncall/incident', async (req, res) => {
  try {
    const { kind, devinEmail } = req.body || {};
    const result = await postOncallIncident({ kind, devinEmail });
    if (result.ok) setRunCookie(res, result.runRef, result.windowMinutes);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (error) {
    logger.error('On-Call incident post failed', { error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * GET /api/oncall/incident/kinds — available SEV-1 incident stories.
 */
router.get('/api/oncall/incident/kinds', (_req, res) => {
  res.json(Object.entries(SEV1_INCIDENTS).map(([id, s]) => ({
    id,
    label: s.label,
    summary: s.summary,
  })));
});

/**
 * GET /api/oncall/incident/state — live status of declared SEV-1 incidents.
 */
router.get('/api/oncall/incident/state', (_req, res) => {
  res.json(getSev1State());
});

module.exports = router;
