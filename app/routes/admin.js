const express = require('express');
const { setScenario, getScenarioInfo } = require('../incidentModes');
const logger = require('../telemetry/logger');

const router = express.Router();

/**
 * GET /admin/scenario - Get current scenario info
 */
router.get('/admin/scenario', (req, res) => {
  res.json(getScenarioInfo());
});

/**
 * POST /admin/scenario - Switch the active scenario
 * Body: { "scenario": "healthy" | "slow-db" | "checkout-regression" | "dependency-timeout" }
 */
router.post('/admin/scenario', (req, res) => {
  try {
    const { scenario } = req.body;
    if (!scenario) {
      return res.status(400).json({ error: 'Missing "scenario" in request body' });
    }

    const result = setScenario(scenario);

    logger.info('Scenario changed', {
      newScenario: result.scenario,
      startedAt: result.startedAt,
      changedBy: req.query.persona || 'admin',
    });

    res.json({
      success: true,
      message: `Scenario switched to "${result.scenario}"`,
      ...result,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /admin/info - Get app info for debugging
 */
router.get('/admin/info', (req, res) => {
  res.json({
    service: process.env.DD_SERVICE || 'checkout-api',
    version: process.env.DD_VERSION || process.env.APP_VERSION || '1.0.0',
    environment: process.env.DD_ENV || 'demo',
    scenario: getScenarioInfo(),
    node: process.version,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    pid: process.pid,
  });
});

module.exports = router;
