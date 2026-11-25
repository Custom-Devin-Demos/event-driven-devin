const express = require('express');
const svc = require('../../services/verticals/13ba0f05');

const router = express.Router();

// `reports: 'off'` (or `?reports=off` on the page) keeps the planted failure but skips Sentry/Jira/Slack/Devin; `x-synthetic` is local-only.
const alertsSuppressed = req => (req.body && req.body.reports === 'off')
  || (Boolean(req.headers['x-synthetic']) && process.env.NODE_ENV !== 'production');
const clip = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : undefined);
const devinFields = body => ({
  devinUserId: clip(body.devinUserId, 128),
  devinOrgId: clip(body.devinOrgId, 128),
  devinEmail: clip(body.devinEmail, 254),
});

function handle(fn) {
  return async (req, res) => {
    try {
      res.json({ success: true, ...(await fn(req)) });
    } catch (error) {
      res.status(error.status || 500).json({
        success: false, error: error.publicMessage || error.message, errorClass: error.name,
        code: error.code || 'MAINSPRING_REQUEST_FAILED', reference: error.reference, incidentId: error.incidentId, requestId: req.requestId,
      });
    }
  };
}

router.get('/api/13ba0f05/fleet', handle(() => svc.getFleet()));
router.post('/api/13ba0f05/fuel-change', handle(async (req) => {
  const body = req.body || {};
  const change = await svc.applyFuelChange({
    siteId: clip(body.siteId, 32), fuelId: clip(body.fuelId, 32), suppressAlerts: alertsSuppressed(req), ...devinFields(body),
  });
  return { change };
}));
router.post('/api/13ba0f05/reset', handle(() => svc.resetFleet()));
router.get('/api/13ba0f05/incidents', handle(() => ({ incidents: svc.listIncidents() })));
router.get('/api/13ba0f05/ideas', handle(() => svc.listIdeas()));
router.post('/api/13ba0f05/ideas', handle(async (req) => {
  const body = req.body || {};
  return { request: await svc.createIdeaRequest({ ideaId: clip(body.ideaId, 64), ...devinFields(body) }) };
}));

module.exports = router;
