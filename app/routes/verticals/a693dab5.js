const express = require('express');
const {
  getFleet,
  getEngine,
  getOperatorSchema,
  listRuns,
  runAllOperators,
  runPipeline,
  startScheduler,
} = require('../../services/verticals/a693dab5');

const router = express.Router();

router.get('/api/a693dab5/fleet', (_req, res) => {
  res.json(getFleet());
});

router.get('/api/a693dab5/runs', (req, res) => {
  res.json({ runs: listRuns({
    limit: req.query.limit,
    operatorCode: req.query.operator,
  }) });
});

router.get('/api/a693dab5/engines/:esn', (req, res) => {
  const result = getEngine(req.params.esn);
  if (!result) return res.status(404).json({ error: 'Engine not found' });
  return res.json(result);
});

router.post('/api/a693dab5/runs', async (req, res) => {
  const body = req.body || {};
  const operatorCode = body.operatorCode || 'all';
  try {
    if (operatorCode !== 'all' && !getOperatorSchema(operatorCode)) {
      return res.status(400).json({ error: 'Unknown operator' });
    }
    const runs = operatorCode === 'all'
      ? await runAllOperators({ ...body, trigger: 'manual' })
      : [await runPipeline(operatorCode, { ...body, trigger: 'manual' })];
    return res.status(200).json({ runs, fleet: getFleet() });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

if (process.env.NODE_ENV !== 'test' && process.env.A693DAB5_SCHEDULER_ENABLED === 'true') startScheduler();

module.exports = router;
