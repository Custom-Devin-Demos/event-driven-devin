const express = require('express');
const { getScenarioInfo } = require('../incidentModes');

const router = express.Router();

router.get('/health', (req, res) => {
  const scenarioInfo = getScenarioInfo();
  res.json({
    status: 'ok',
    service: process.env.DD_SERVICE || 'checkout-api',
    version: process.env.DD_VERSION || process.env.APP_VERSION || '1.0.0',
    environment: process.env.DD_ENV || 'demo',
    scenario: scenarioInfo.scenario,
    scenarioStartedAt: scenarioInfo.startedAt,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
