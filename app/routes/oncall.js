const express = require('express');
const path = require('path');
const fs = require('fs');
const logger = require('../telemetry/logger');
const {
  ALERT_SCENARIOS,
  postOncallAlert,
  INFRA_INCIDENTS,
  postOncallInfraIncident,
  getInfraState,
  isPlainObject,
  setOncallConfigOverride,
  getOncallConfigView,
} = require('../services/oncall');
const { getOncallSkin, ONCALL_SKINS } = require('../../config/oncall-skins');
const { normalizeAlertDestination } = require('../services/alert-destination');
const {
  FLEET,
  isFleetReport,
  normalizeReport: normalizeFleetReport,
  reportEtaFailure,
  getEtaFailureStatus,
} = require('../services/oncall-verticals/fleet');
const {
  PARTIFUL,
  isPartifulReport,
  normalizeReport: normalizePartifulReport,
  reportRsvpPageFailure,
  getRsvpPageFailureStatus,
} = require('../services/oncall-verticals/partiful');
const {
  ACCOUNT_OPENING,
  isAccountOpeningReport,
  isKnownReference: isKnownAccountOpeningReference,
  hasReference: hasAccountOpeningReference,
  normalizeReport: normalizeAccountOpeningReport,
  reportIdCheckFailure,
} = require('../services/oncall-verticals/account-opening');

const router = express.Router();

/**
 * Per-IP hourly caps on the on-call mutation endpoints. These endpoints
 * create real Slack messages and Datadog incidents, so unauthenticated
 * drive-by traffic must not be able to spam them unbounded — while one
 * abusive caller must not lock out legitimate presenters. Sliding
 * one-hour window, in-process; the legacy vertical APIs and all
 * GET/state endpoints are uncapped. Invalid requests (unknown vertical
 * or infra kind) are rejected before consuming quota.
 */
const ONCALL_HOURLY_CAPS = {
  trigger: 50,
  alert: 50,
  infra: 50,
  config: 120,
};
const capWindows = new Map();
const CAP_WINDOW_MS = 3600000;

// The app sits behind nginx, which appends the real client address to
// X-Forwarded-For; the last entry is the one our proxy added and the only
// one a caller cannot spoof. Direct connections fall back to the socket.
function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    const parts = forwarded.split(',');
    return parts[parts.length - 1].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function oncallCap(name) {
  const limit = ONCALL_HOURLY_CAPS[name];
  if (!limit) throw new Error(`No hourly cap configured for "${name}"`);
  return (req, res, next) => {
    const now = Date.now();
    const cutoff = now - CAP_WINDOW_MS;
    const key = `${name}:${clientIp(req)}`;
    let window = capWindows.get(key);
    if (!window) {
      window = [];
      capWindows.set(key, window);
    }
    while (window.length && window[0] <= cutoff) window.shift();
    if (window.length >= limit) {
      logger.warn('On-Call hourly cap hit', { cap: name, limit, ip: clientIp(req) });
      const retryAfterSec = Math.ceil((window[0] + CAP_WINDOW_MS - now) / 1000);
      res.set('Retry-After', String(Math.max(retryAfterSec, 1)));
      return res.status(429).json({
        ok: false,
        error: `Hourly limit reached for this action (${limit}/hour). Try again later.`,
      });
    }
    window.push(now);
    if (window.length === 1) pruneCapWindows(cutoff);
    next();
  };
}

// Drop idle per-IP windows so the map cannot grow unbounded.
function pruneCapWindows(cutoff) {
  for (const [key, window] of capWindows) {
    while (window.length && window[0] <= cutoff) window.shift();
    if (!window.length) capWindows.delete(key);
  }
}

// Keep the on-call surface out of search indexes; it is shared by URL only.
router.use('/oncall', (_req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

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

const ALERT_CARD_KEYS = new Set([
  'title', 'service', 'endpointLabel', 'release', 'team', 'metricQuery', 'metricValue', 'threshold',
  'baseline', 'symptom', 'impact',
]);
for (const skin of Object.values(ONCALL_SKINS)) {
  if (!ALERT_SCENARIOS[skin.vertical]) {
    logger.warn('On-Call skin references unknown vertical', {
      skin: skin.slug,
      vertical: skin.vertical,
    });
  }
  const pageFile = skin.page && skin.page.file;
  if (
    pageFile &&
    !fs.existsSync(path.join(__dirname, '..', 'public', 'verticals', pageFile))
  ) {
    logger.warn('On-Call skin references missing page file', {
      skin: skin.slug,
      pageFile,
    });
  }
  if (skin.alertCard != null) {
    const invalidAlertCardKeys = isPlainObject(skin.alertCard)
      ? Object.entries(skin.alertCard)
        .filter(([key, value]) => !ALERT_CARD_KEYS.has(key) || typeof value !== 'string')
        .map(([key]) => key)
      : ['alertCard'];
    if (invalidAlertCardKeys.length) {
      logger.warn('On-Call skin alertCard has unknown or non-string fields', {
        skin: skin.slug,
        fields: invalidAlertCardKeys,
      });
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
  const rebrand = !page.file;
  const themeVars = Object.entries(page.theme || (rebrand ? skin.theme : {}) || {})
    .filter(([k, v]) => /^--[a-z0-9-]+$/i.test(k) && /^[^<>{};]*$/.test(String(v)))
    .map(([k, v]) => `${k}: ${v};`)
    .join(' ');
  // A skin with its own custom page file (page.file) is natively branded:
  // skip the title/logo rewrite and only remove the back link and add the
  // disclaimer bar.
  return `
  <style>:root { ${themeVars} }</style>
  <script>
    (function () {
      if (${JSON.stringify(rebrand)}) document.title = ${jsLiteral(page.title || skin.company)};
      var logo = ${JSON.stringify(rebrand)} ? document.querySelector('.logo') : null;
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
function serveSkinPage(skin, res, next) {
  const scenario = ALERT_SCENARIOS[skin.vertical];
  if (!scenario) return next();
  const pageFile = (skin.page && skin.page.file) || scenario.page;
  const pagePath = path.join(__dirname, '..', 'public', 'verticals', pageFile);
  fs.readFile(pagePath, 'utf8', (err, html) => {
    if (err) return next(err);
    res.type('html').send(
      html.replace('</body>', () => `${buildOncallShim(scenario, skin.slug, skin.hideRibbon)}\n${buildSkinBrandShim(skin)}\n</body>`)
    );
  });
}

router.get('/oncall/c/:slug', (req, res, next) => {
  const skin = getOncallSkin(req.params.slug);
  if (!skin) return next();
  serveSkinPage(skin, res, next);
});

/**
 * A native skin page whose primary action only exists as an on-call endpoint
 * (skin.oncallOnly) has no working unshimmed variant, so its direct
 * /<page-slug> URL (which the vertical page registry would otherwise serve
 * bare) is served shimmed, identical to /oncall/c/:slug.
 */
for (const skin of Object.values(ONCALL_SKINS)) {
  if (!skin.oncallOnly || !skin.page || !skin.page.file) continue;
  router.get(`/${path.basename(skin.page.file, '.html')}`, (_req, res, next) => serveSkinPage(skin, res, next));
}

/**
 * GET /oncall — On-Call demo control page.
 */
const ONCALL_HUB_PAGE = path.join(__dirname, '..', 'public', 'oncall.html');
router.get('/oncall', (_req, res) => {
  res.sendFile(ONCALL_HUB_PAGE);
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
const ALERTS_CHANNEL_LABEL = process.env.SLACK_ONCALL_ALERTS_CHANNEL_NAME || '#oncall-alerts';

function buildOncallShim(scenario, skinSlug, hideRibbon) {
  return `
  <div id="oncall-dot" title="Devin On-Call demo" style="display:none;position:fixed;bottom:16px;right:16px;z-index:9999;width:14px;height:14px;border-radius:50%;background:#3fb950;border:2px solid #0d1117;box-shadow:0 2px 8px rgba(0,0,0,0.4);cursor:pointer;"></div>
  <div id="oncall-ribbon" style="${hideRibbon ? 'display:none;' : ''}position:fixed;bottom:16px;right:16px;z-index:9999;background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:8px;padding:10px 14px;font-family:monospace;font-size:12px;box-shadow:0 4px 12px rgba(0,0,0,0.3);">
    <div style="font-weight:700;color:#f0f6fc;margin-bottom:4px;">Devin On-Call demo</div>
    <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
      <input type="checkbox" id="oncall-unique" checked style="accent-color:#58a6ff;appearance:auto;-webkit-appearance:checkbox;flex:none;width:13px;min-width:13px;height:13px;min-height:13px;margin:0;padding:0;border:0;border-radius:0;background:none;">
      Unique per run
    </label>
    <div id="oncall-status" style="margin-top:6px;max-width:220px;"></div>
  </div>
  <script>
    (function () {
      const apiPath = ${JSON.stringify(scenario.apiPath)};
      const oncallApiPath = ${JSON.stringify(scenario.oncallApiPath)};
      const vertical = ${JSON.stringify(scenario.vertical)};
      const skinSlug = ${JSON.stringify(skinSlug || null)};
      // Only climbing-latency scenarios keep a retry window: repeat submits
      // demonstrate the per-request growth, so they join the open incident.
      // Every other scenario posts a fresh incident on every submit.
      const retryWindowEnabled = ${JSON.stringify(Boolean(scenario.retryWindow))};
      // Premium accounts are pre-cleared by the compliance program and do
      // not exhibit the on-call degradation, so on-call pages default the
      // tier selector to standard.
      var tierSelect = document.getElementById('accountTier');
      if (vertical === 'banking' && tierSelect) tierSelect.value = 'standard';
      const origFetch = window.fetch.bind(window);
      // After the alert lands, collapse the demo ribbon to a small dot so it
      // doesn't sit over the customer page; clicking the dot re-expands it.
      var ribbonEl = document.getElementById('oncall-ribbon');
      var dotEl = document.getElementById('oncall-dot');
      var ribbonHidden = ${JSON.stringify(Boolean(hideRibbon))};
      var ribbonCollapsed = false;
      var collapseTimer = null;
      function scheduleCollapse() {
        if (collapseTimer) clearTimeout(collapseTimer);
        collapseTimer = setTimeout(collapseRibbon, 4000);
      }
      function collapseRibbon() {
        collapseTimer = null;
        ribbonCollapsed = true;
        ribbonEl.style.display = 'none';
        if (ribbonHidden) return;
        dotEl.style.display = 'block';
      }
      function expandRibbon() {
        ribbonCollapsed = false;
        if (ribbonHidden) return;
        dotEl.title = 'Devin On-Call demo';
        dotEl.style.display = 'none';
        ribbonEl.style.display = 'block';
      }
      dotEl.addEventListener('click', expandRibbon);
      // Climbing-latency scenarios only: the first primary action posts the
      // alert and opens a 60s window during which retries exercise the
      // degradation again without opening a separate incident. After the
      // window expires (or on refresh), the next action registers as a fresh
      // occurrence.
      var RETRY_WINDOW_MS = 60 * 1000;
      var alertPostedAt = 0;
      window.fetch = function (url, opts) {
        if (typeof url === 'string' && url.startsWith(apiPath) && (opts && opts.method && opts.method.toUpperCase() === 'POST')) {
          // Reroute the page's primary action to the on-call vertical
          // endpoint: the scenario's real degradation fires and Sentry/
          // Datadog capture genuine telemetry. The alert card is posted
          // alongside. Legacy endpoints are untouched.
          if (retryWindowEnabled && alertPostedAt && Date.now() - alertPostedAt < RETRY_WINDOW_MS) {
            var statusEl = document.getElementById('oncall-status');
            var retryMsg = 'Retry joined the open incident (60s window)';
            if (statusEl) {
              statusEl.style.color = '#c9d1d9';
              statusEl.textContent = retryMsg;
            }
            if (ribbonCollapsed) dotEl.title = retryMsg;
            else scheduleCollapse();
            return origFetch(url.replace(apiPath, oncallApiPath), opts);
          }
          var postedAt = Date.now();
          alertPostedAt = postedAt;
          if (ribbonCollapsed) expandRibbon();
          const unique = document.getElementById('oncall-unique').checked;
          var alertDestination = localStorage.getItem('alertDestination') === 'teams' ? 'teams' : 'slack';
          var triggerUrl = '/api/oncall/trigger/' + vertical;
          var triggerBody = {
              unique: unique,
              skin: skinSlug,
              devinEmail: localStorage.getItem('devinEmail') || '',
              devinUserId: localStorage.getItem('devinUserId') || '',
              devinOrgId: localStorage.getItem('devinOrgId') || '',
              alertDestination: alertDestination,
          };
          var postedMsg = 'Alert posted to ' + ${JSON.stringify(ALERTS_CHANNEL_LABEL)};
          var skippedMsg = 'Alert post skipped — no alert reached Slack';
          var failedMsg = 'Alert post failed';
          origFetch(triggerUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(triggerBody),
          }).then(function (r) { return r.json(); }).then(function (d) {
            const el = document.getElementById('oncall-status');
            if (d.skipped) {
              console.warn('On-call trigger post skipped: ' + d.error);
              if (ribbonCollapsed) expandRibbon();
              el.style.color = '#f85149';
              el.textContent = skippedMsg;
              if (alertPostedAt === postedAt) alertPostedAt = 0;
              return;
            }
            if (!d.ok && alertPostedAt === postedAt) alertPostedAt = 0;
            if (ribbonCollapsed) expandRibbon();
            el.style.color = d.ok ? '#3fb950' : '#f85149';
            var deliveredMsg = !d.teams ? postedMsg : (d.channel ? postedMsg + ' and Teams' : 'Alert posted to Teams');
            if (d.teamsFailed) deliveredMsg += ' (Teams is not set up on this server, so it went to Slack)';
            el.textContent = d.ok ? deliveredMsg : (d.error || failedMsg);
            if (d.ok && !d.teamsFailed) scheduleCollapse();
            else if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
          }).catch(function () {
            if (alertPostedAt === postedAt) alertPostedAt = 0;
            if (ribbonCollapsed) expandRibbon();
            var el = document.getElementById('oncall-status');
            if (el) {
              el.style.color = '#f85149';
              el.textContent = failedMsg;
            }
          });
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
router.post('/api/oncall/trigger/:vertical', (req, res, next) => {
  if (!ALERT_SCENARIOS[req.params.vertical]) {
    return res.status(404).json({ ok: false, error: `Unknown vertical: ${req.params.vertical}` });
  }
  next();
}, oncallCap('trigger'), async (req, res) => {
  try {
    const {
      unique, devinEmail, devinUserId, devinOrgId, skin, alertDestination,
    } = req.body || {};
    const skinConfig = getOncallSkin(skin);
    const skinMatches = Boolean(skinConfig && skinConfig.vertical === req.params.vertical);
    if (skinConfig && !skinMatches) {
      logger.warn('On-Call trigger skin/vertical mismatch — using generic alert', {
        skin: skinConfig.slug,
        skinVertical: skinConfig.vertical,
        triggeredVertical: req.params.vertical,
      });
    }
    const result = await postOncallAlert(req.params.vertical, {
      unique: unique !== false,
      devinEmail,
      devinUserId,
      devinOrgId,
      skin: skinMatches ? skinConfig : null,
      destination: normalizeAlertDestination(alertDestination),
    });
    res.status(result.ok || result.skipped ? 200 : 400).json(result);
  } catch (error) {
    logger.error('On-Call trigger failed', { error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});

const FLEET_FAILURE_PATH = `/api/oncall/${FLEET.slug}/eta-failure`;

/**
 * POST /api/oncall/26a3d261/eta-failure — invariant failure reported by the
 * native Fleet app when "Share live ETA" computes an arrival that is not
 * after departure. Acknowledged at once with a reference; the alert card and
 * the (macOS) Devin session follow asynchronously.
 */
router.post(FLEET_FAILURE_PATH, (req, res, next) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (!isFleetReport(body)) {
    return res.status(400).json({
      received: false,
      error: `Expected a fleet-mobile/<ios|macos> source with service ${FLEET.service}`,
    });
  }
  const report = normalizeFleetReport(body);
  if (!report) {
    return res.status(400).json({
      received: false,
      error: 'Expected assetId plus ISO-8601 departure and arrival, with arrival not after departure',
    });
  }
  req.fleetReport = report;
  next();
}, oncallCap('trigger'), (req, res) => {
  const result = reportEtaFailure(req.fleetReport);
  if (!result) {
    return res.status(400).json({ received: false, error: 'Invalid report' });
  }
  return res.status(202).json({
    received: true,
    reference: result.reference,
    statusToken: result.statusToken,
    service: FLEET.service,
    sessionRequested: true,
    receivedAt: new Date().toISOString(),
  });
});

/**
 * GET /api/oncall/26a3d261/eta-failure/:reference — outcome of a report, so
 * the app can show the alert/session link on its failure card. Requires the
 * statusToken from the 202 response in the `X-Status-Token` header (never
 * the query string, which would land in access logs):
 * the reference itself is printed on the alert card and is not a secret.
 */
router.get(`${FLEET_FAILURE_PATH}/:reference`, (req, res) => {
  const token = req.get('x-status-token');
  const status = getEtaFailureStatus(req.params.reference, token);
  if (!status) return res.status(404).json({ error: 'Unknown reference' });
  return res.json(status);
});

const PARTIFUL_FAILURE_PATH = `/api/oncall/${PARTIFUL.slug}/rsvp-page-failure`;

/**
 * POST /api/oncall/205bc15f/rsvp-page-failure — blank RSVP page reported by
 * the native Partiful app when it cannot build the event page a guest
 * opened. Acknowledged at once with a reference; the alert card and the
 * (macOS) Devin session follow asynchronously.
 */
router.post(PARTIFUL_FAILURE_PATH, (req, res, next) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (!isPartifulReport(body)) {
    return res.status(400).json({
      received: false,
      error: `Expected a partiful-rsvp/<ios|macos|web> source with service ${PARTIFUL.service}`,
    });
  }
  const report = normalizePartifulReport(body);
  if (!report) {
    return res.status(400).json({
      received: false,
      error: 'Expected an eventId slug plus a known reason code',
    });
  }
  req.partifulReport = report;
  next();
}, oncallCap('trigger'), (req, res) => {
  const result = reportRsvpPageFailure(req.partifulReport);
  if (!result) {
    return res.status(400).json({ received: false, error: 'Invalid report' });
  }
  return res.status(202).json({
    received: true,
    reference: result.reference,
    statusToken: result.statusToken,
    service: PARTIFUL.service,
    sessionRequested: true,
    receivedAt: new Date().toISOString(),
  });
});

/**
 * GET /api/oncall/205bc15f/rsvp-page-failure/:reference — outcome of a
 * report, so the app can show "Devin is investigating" under the blank
 * page. Requires the statusToken from the 202 response in the
 * `X-Status-Token` header (never the query string, which would land in
 * access logs): the reference itself is printed on the alert card and is
 * not a secret.
 */
router.get(`${PARTIFUL_FAILURE_PATH}/:reference`, (req, res) => {
  const token = req.get('x-status-token');
  const status = getRsvpPageFailureStatus(req.params.reference, token);
  if (!status) return res.status(404).json({ error: 'Unknown reference' });
  return res.json(status);
});

const ACCOUNT_OPENING_FAILURE_PATH = `/api/oncall/${ACCOUNT_OPENING.slug}/id-check-failure`;
const accountOpeningTriggerCap = oncallCap('trigger');

/**
 * POST /api/oncall/6c2cc636/id-check-failure — online ID check rejection
 * reported by the native CommBank account-opening app when Agree & Continue
 * cannot accept the selected document. Acknowledged at once with the
 * incident reference; exactly one alert card and one macOS Devin session
 * follow asynchronously, the session linked in the alert's thread.
 */
router.post(ACCOUNT_OPENING_FAILURE_PATH, (req, res, next) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (!isAccountOpeningReport(body)) {
    return res.status(400).json({
      received: false,
      error: `Expected an account-opening/<ios|macos> source with service ${ACCOUNT_OPENING.service}`,
    });
  }
  const report = normalizeAccountOpeningReport(body);
  if (!report) {
    return res.status(400).json({
      received: false,
      error: 'Expected a known reason code plus bounded document and applicant facts',
    });
  }
  // A retried report with a reference the pipeline already knows is
  // acknowledged here, before the shared trigger cap, so duplicates
  // never burn quota. Unknown references continue into the cap.
  if (report.reference && isKnownAccountOpeningReference(report.reference)) {
    return res.status(202).json({
      received: true,
      reference: report.reference,
      service: ACCOUNT_OPENING.service,
      sessionRequested: true,
      receivedAt: new Date().toISOString(),
    });
  }
  // A cached but incomplete reference is a retry of the same incident:
  // it bypasses the trigger cap entirely rather than consuming it.
  if (report.reference && hasAccountOpeningReference(report.reference)) {
    req.accountOpeningRetry = true;
  }
  req.accountOpeningReport = report;
  next();
}, (req, res, next) => (req.accountOpeningRetry ? next() : accountOpeningTriggerCap(req, res, next)), (req, res) => {
  const result = reportIdCheckFailure(req.accountOpeningReport);
  if (!result) {
    return res.status(400).json({ received: false, error: 'Invalid report' });
  }
  return res.status(202).json({
    received: true,
    reference: result.reference,
    service: ACCOUNT_OPENING.service,
    sessionRequested: true,
    receivedAt: new Date().toISOString(),
  });
});

/**
 * GET /api/oncall/scenarios — available alert scenarios
 */
router.get('/api/oncall/scenarios', (_req, res) => {
  const scenarios = Object.entries(ALERT_SCENARIOS)
    .filter(([, s]) => !s.unlisted)
    .map(([id, s]) => ({
      id,
      brand: s.brand,
      endpoint: s.endpoint,
      monitor: s.monitor,
      symptom: s.symptom,
      retryWindow: Boolean(s.retryWindow),
    }));
  res.json({ scenarios, teamsDefaultWebhook: Boolean(process.env.ONCALL_TEAMS_WEBHOOK_URL) });
});

/**
 * POST /api/oncall/alert — post an alert card to #oncall-alerts
 * Body: { scenario: 'banking'|'insurance'|'hightech'|'telco', unique?: boolean }
 */
router.post('/api/oncall/alert', oncallCap('alert'), async (req, res) => {
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
 * POST /api/oncall/infra/:kind — fire an infra-style (SRE) incident:
 * activates the matching built-in scenario (auto-reverts after a window)
 * and posts a Datadog-monitor-style alert card.
 * Kinds: latency, dependency-timeout, memory-leak, slo-burn.
 */
router.post('/api/oncall/infra/:kind', (req, res, next) => {
  if (!INFRA_INCIDENTS[req.params.kind]) {
    return res.status(404).json({ ok: false, error: `Unknown infra incident: ${req.params.kind}` });
  }
  next();
}, oncallCap('infra'), async (req, res) => {
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
router.post('/api/oncall/latency', oncallCap('infra'), async (req, res) => {
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
 * GET /api/oncall/config — effective runtime config for the caller's run
 * (oncall_run cookie / x-synthetic-monitor header), or for ?runRef=.
 * Shows the shipped defaults, any live per-run override, and its expiry.
 */
router.get('/api/oncall/config', (req, res) => {
  let runRef = null;
  if (req.query.runRef !== undefined) {
    if (typeof req.query.runRef !== 'string' || !/^[A-Za-z0-9-]+$/.test(req.query.runRef)) {
      return res.status(400).json({ ok: false, error: 'runRef must match [A-Za-z0-9-]+' });
    }
    runRef = req.query.runRef;
  }
  res.json(getOncallConfigView(runRef));
});

/**
 * POST /api/oncall/config — register a per-run runtime config override (the
 * mitigation surface for on-call incidents).
 * Body: { runRef: string, screeningWindowDays?: number, screeningConcurrency?: number }
 * The runRef comes from the incident (Incident Ref) — explicit so a responder
 * acting from the incident channel can mitigate without browser cookies. The
 * override only affects requests scoped to that run and auto-expires with the
 * incident window, so the shipped configuration is never changed.
 */
router.post('/api/oncall/config', oncallCap('config'), (req, res) => {
  const { runRef, ...patch } = req.body || {};
  const result = setOncallConfigOverride(runRef, patch);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

module.exports = router;
