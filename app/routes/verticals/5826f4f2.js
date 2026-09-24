const express = require('express');
const { runChartQuery, CHART_TYPES, INTERVALS, EVENTS } = require('../../services/verticals/5826f4f2');

const router = express.Router();

router.get('/api/5826f4f2/metadata', (req, res) => {
  res.json({
    chartTypes: Object.entries(CHART_TYPES).map(([id, chart]) => ({ id, label: chart.label })),
    intervals: Object.entries(INTERVALS).map(([id, interval]) => ({ id, label: interval.label })),
    events: Object.entries(EVENTS).map(([id, event]) => ({ id, label: event.label })),
  });
});

router.post('/api/5826f4f2/chart-query', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await runChartQuery({
      projectId: body.projectId,
      eventName: body.eventName,
      chartType: body.chartType,
      interval: body.interval,
      segmentBy: body.segmentBy,
      lookbackDays: body.lookbackDays,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });

    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'CHART_QUERY_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
