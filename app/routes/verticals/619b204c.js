const express = require('express');
const {
  runNightlyBatch, rerunOnTestInstance, resetDemo, sendTestRequest, getConsoleState, getRequestLog, getOrderPayload,
} = require('../../services/verticals/619b204c');

const router = express.Router();

router.get('/api/619b204c/state', (_req, res) => {
  res.json(getConsoleState());
});

router.get('/api/619b204c/requests/:id/log', (req, res) => {
  const log = getRequestLog(req.params.id);
  if (!log) return res.status(404).json({ error: 'Unknown concurrent request' });
  return res.json(log);
});

router.get('/api/619b204c/orders/:orderNumber/payload', (req, res) => {
  const payload = getOrderPayload(req.params.orderNumber);
  if (!payload) return res.status(404).json({ error: 'Unknown order' });
  return res.json(payload);
});

router.post('/api/619b204c/middleware/test', async (req, res) => {
  try {
    const body = req.body || {};
    res.json(await sendTestRequest({ orderNumber: body.orderNumber, lineCount: body.lineCount }));
  } catch (error) {
    res.status(error.statusCode || 500).json({ ok: false, error: error.message });
  }
});

router.post('/api/619b204c/batch/run', async (req, res) => {
  try {
    const body = req.body || {};
    res.json(await runNightlyBatch({
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    }));
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      requestId: req.requestId,
      ...getConsoleState(),
    });
  }
});

router.post('/api/619b204c/batch/run/reset', (_req, res) => {
  res.json(resetDemo());
});

router.post('/api/619b204c/test-instance/rerun', async (_req, res) => {
  try {
    const result = await rerunOnTestInstance();
    res.status(result.success ? 200 : 500).json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message, ...getConsoleState() });
  }
});

module.exports = router;
