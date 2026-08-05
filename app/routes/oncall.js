const express = require('express');
const path = require('path');
const fs = require('fs');
const logger = require('../telemetry/logger');
const {
  ALERT_SCENARIOS,
  BUG_REPORTS,
  postOncallAlert,
  postOncallBugReport,
  INFRA_INCIDENTS,
  postOncallInfraIncident,
  postOncallIncident,
} = require('../services/oncall');

const router = express.Router();

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
 * /oncall/<vertical>. It reroutes the page's own API call to the alert-only
 * on-call trigger, so the presenter uses the genuine product UI (and sees the
 * genuine error state) while the alert lands in #oncall-alerts with no legacy
 * Devin trigger.
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
      const vertical = ${JSON.stringify(scenario.vertical)};
      const origFetch = window.fetch.bind(window);
      window.fetch = function (url, opts) {
        if (typeof url === 'string' && url.startsWith(apiPath)) {
          // Execute the real vertical API in on-call mode: the planted bug
          // fires and Sentry/Datadog capture genuine telemetry, but the
          // x-oncall-mode header suppresses the legacy Slack/Devin trigger.
          // The on-call alert card is posted alongside.
          const realOpts = Object.assign({}, opts);
          realOpts.headers = Object.assign({}, (opts && opts.headers) || {}, { 'x-oncall-mode': '1' });
          const unique = document.getElementById('oncall-unique').checked;
          origFetch('/api/oncall/trigger/' + vertical, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ unique: unique, devinEmail: localStorage.getItem('devinEmail') || '' }),
          }).then(function (r) { return r.json(); }).then(function (d) {
            const el = document.getElementById('oncall-status');
            el.style.color = d.ok ? '#3fb950' : '#f85149';
            el.textContent = d.ok ? 'Alert posted to #oncall-alerts' : (d.error || 'Alert post failed');
          }).catch(function () {});
          return origFetch(url, realOpts);
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
 * shimmed branded pages call this alongside the real vertical API (which runs
 * in on-call mode so telemetry fires but the legacy Devin trigger does not).
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
    error: `${s.errorType}: ${s.errorValue}`,
  }));
  const bugReports = Object.entries(BUG_REPORTS).map(([id, text]) => ({ id, text }));
  res.json({ scenarios, bugReports });
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
 * Body: { scenario?: string, text?: string, reporter?: { name, email }, severity?: string, productArea?: string }
 */
router.post('/api/oncall/bug', async (req, res) => {
  try {
    const { scenario, text, reporter, severity, productArea, devinEmail } = req.body || {};
    const result = await postOncallBugReport({ scenarioId: scenario, text, reporter, severity, productArea, devinEmail });
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
    res.status(result.ok ? 200 : 400).json(result);
  } catch (error) {
    logger.error('On-Call infra trigger failed', { kind: req.params.kind, error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/oncall/latency — back-compat alias for the latency infra incident.
 */
router.post('/api/oncall/latency', async (req, res) => {
  try {
    const result = await postOncallInfraIncident('latency', { devinEmail: (req.body || {}).devinEmail });
    res.status(result.ok ? 200 : 400).json(result);
  } catch (error) {
    logger.error('On-Call latency trigger failed', { error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/oncall/incident — post a SEV-1 incident burst to #oncall-alerts
 */
router.post('/api/oncall/incident', async (req, res) => {
  try {
    const result = await postOncallIncident({ devinEmail: (req.body || {}).devinEmail });
    res.status(result.ok ? 200 : 400).json(result);
  } catch (error) {
    logger.error('On-Call incident post failed', { error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});

module.exports = router;
