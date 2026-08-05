const express = require('express');
const path = require('path');
const fs = require('fs');
const logger = require('../telemetry/logger');
const {
  ALERT_SCENARIOS,
  BUG_REPORTS,
  postOncallAlert,
  postOncallBugReport,
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
      const errorBody = ${JSON.stringify(JSON.stringify({
        success: false,
        error: scenario.errorValue,
        errorClass: scenario.errorType,
        code: 'INTERNAL_ERROR',
      }))};
      const origFetch = window.fetch.bind(window);
      window.fetch = function (url, opts) {
        if (typeof url === 'string' && url.startsWith(apiPath)) {
          // Never hit the real vertical API from on-call mode: it would fire
          // the legacy alert/Devin pipeline. Post the on-call alert instead
          // and hand the page its genuine 500 error shape.
          const unique = document.getElementById('oncall-unique').checked;
          return origFetch('/api/oncall/trigger/' + vertical, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ unique: unique }),
          }).then(function (r) { return r.json(); }).then(function (d) {
            const el = document.getElementById('oncall-status');
            el.style.color = d.ok ? '#3fb950' : '#f85149';
            el.textContent = d.ok ? 'Alert posted to #oncall-alerts' : (d.error || 'Alert post failed');
            return new Response(errorBody, { status: 500, headers: { 'Content-Type': 'application/json' } });
          });
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
 * POST /api/oncall/trigger/:vertical — alert-only trigger used by the shimmed
 * branded pages. Posts the alert card; the shim renders the vertical's real
 * 500-error shape in the page UI.
 */
router.post('/api/oncall/trigger/:vertical', async (req, res) => {
  const scenario = ALERT_SCENARIOS[req.params.vertical];
  if (!scenario) {
    return res.status(404).json({ ok: false, error: `Unknown vertical: ${req.params.vertical}` });
  }
  try {
    const { unique } = req.body || {};
    const result = await postOncallAlert(req.params.vertical, { unique: unique !== false });
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
    const { scenario, unique } = req.body || {};
    const result = await postOncallAlert(scenario, { unique: unique !== false });
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
    const { scenario, text, reporter, severity, productArea } = req.body || {};
    const result = await postOncallBugReport({ scenarioId: scenario, text, reporter, severity, productArea });
    res.status(result.ok ? 200 : 400).json(result);
  } catch (error) {
    logger.error('On-Call bug report post failed', { error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/oncall/incident — post a SEV-1 incident burst to #oncall-alerts
 */
router.post('/api/oncall/incident', async (req, res) => {
  try {
    const result = await postOncallIncident();
    res.status(result.ok ? 200 : 400).json(result);
  } catch (error) {
    logger.error('On-Call incident post failed', { error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});

module.exports = router;
