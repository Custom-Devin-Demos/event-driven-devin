const express = require('express');
const {
  APP_SERVICE,
  isAppReport,
  reportAppFailure,
} = require('../../services/verticals/a75ccde9');
const {
  AUDIT_SERVICE,
  auditPlanPage,
  reportQualityFindings,
} = require('../../services/verticals/a75ccde9-quality');

const router = express.Router();
const ERROR_PATH = '/api/a75ccde9/error';
const AUDIT_PATH = '/api/a75ccde9/quality-audit';

function allowCrossOrigin(req, res, next) {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
}

router.options(ERROR_PATH, allowCrossOrigin);

router.post(ERROR_PATH, allowCrossOrigin, (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (!isAppReport(body)) {
    return res.status(400).json({
      received: false,
      error: `Expected a plan-page-web/<platform> source with service ${APP_SERVICE}`,
    });
  }

  const { reference } = reportAppFailure(body);
  return res.status(202).json({
    received: true,
    reference,
    service: APP_SERVICE,
    sessionRequested: true,
    receivedAt: new Date().toISOString(),
  });
});

// Runs the same audit as `npm run audit:fox` on demand, so the nightly frontend
// quality gate can be fired live from the demo. Findings raise the alert and open
// a Devin session; a clean page returns 200 and raises nothing.
router.post(AUDIT_PATH, (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const findings = auditPlanPage();

  if (findings.length === 0) {
    return res.status(200).json({
      service: AUDIT_SERVICE,
      violations: 0,
      findings: [],
      sessionRequested: false,
      auditedAt: new Date().toISOString(),
    });
  }

  const { reference } = reportQualityFindings(findings, {
    devinUserId: body.devinUserId,
    devinOrgId: body.devinOrgId,
    devinEmail: body.devinEmail,
  });

  return res.status(202).json({
    service: AUDIT_SERVICE,
    reference,
    violations: findings.length,
    findings,
    sessionRequested: true,
    auditedAt: new Date().toISOString(),
  });
});

module.exports = router;
