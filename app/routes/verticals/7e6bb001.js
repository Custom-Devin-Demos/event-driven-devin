const express = require('express');
const { processRemediation, VULNERABILITIES, SERVICENOW_TICKETS, RELEASES } = require('../../services/verticals/7e6bb001');

const router = express.Router();

/**
 * GET /api/7e6bb001/vulnerabilities — returns CVE list, ServiceNow tickets, and release schedule
 */
router.get('/api/7e6bb001/vulnerabilities', (_req, res) => {
  res.json({ vulnerabilities: VULNERABILITIES, tickets: SERVICENOW_TICKETS, releases: RELEASES });
});

/**
 * POST /api/7e6bb001/remediate — process a CVE remediation request
 */
router.post('/api/7e6bb001/remediate', async (req, res) => {
  try {
    const result = await processRemediation({
      cveId: req.body.cveId || 'CVE-2024-38816',
      severity: req.body.severity || 'critical',
      package: req.body.package || 'org.springframework:spring-webmvc',
      currentVersion: req.body.currentVersion || '5.3.27',
      fixedVersion: req.body.fixedVersion || '5.3.39',
      application: req.body.application || 'MyHumana Member Portal',
      userId: req.body.userId || 'usr_7e6bb001_secops',
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    const statusCode = error.code === 'CVE_NOT_FOUND' ? 404 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'REMEDIATION_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
