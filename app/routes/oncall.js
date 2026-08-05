const express = require('express');
const path = require('path');
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
 * Body: { scenario?: string, text?: string }
 */
router.post('/api/oncall/bug', async (req, res) => {
  try {
    const { scenario, text } = req.body || {};
    const result = await postOncallBugReport({ scenarioId: scenario, text });
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
