const express = require('express');
const { verifySessionSecret } = require('../../middleware/verify-session-secret');
const { getWorkOrder, checkAvailability, resetAvailability } = require('../../services/verticals/cfe13c8b');

const router = express.Router();
const reportsEnabled = req => req.body?.reports === 'on' && !req.get('x-synthetic');
const authorizeReports = (req, res, next) => reportsEnabled(req) ? verifySessionSecret(req, res, next) : next();
const stringOrUndefined = value => typeof value === 'string' && value ? value : undefined;

router.get('/api/cfe13c8b/work-order', (_req, res) => res.json(getWorkOrder()));
router.post('/api/cfe13c8b/availability', authorizeReports, (req, res) => {
  const { branchId, partNumber, devinUserId, devinOrgId, devinEmail } = req.body || {};
  const { status, body } = checkAvailability({
    branchId,
    partNumber,
    reports: reportsEnabled(req),
    presenter: {
      devinUserId: stringOrUndefined(devinUserId),
      devinOrgId: stringOrUndefined(devinOrgId),
      devinEmail: stringOrUndefined(devinEmail),
    },
  });
  res.status(status).json(body);
});
router.post('/api/cfe13c8b/availability/reset', authorizeReports, (req, res) => {
  const workOrder = resetAvailability({ reports: reportsEnabled(req) });
  if (!workOrder) return res.status(409).json({ error: 'The alert is still being sent. Try again in a moment.' });
  return res.json(workOrder);
});

module.exports = router;
