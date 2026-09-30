const express = require('express');
const {
  runInspectionScan,
  APPLICATIONS,
  SCAN_MODES,
  ZONES,
  LATENCY_SLO,
} = require('../../services/verticals/04525b56');

const router = express.Router();

router.get('/api/04525b56/applications', (req, res) => {
  res.json({
    success: true,
    applications: Object.entries(APPLICATIONS).map(([key, application]) => ({
      key,
      label: application.label,
      platform: application.platform,
      diesPerZone: application.diesPerZone,
    })),
    scanModes: Object.entries(SCAN_MODES).map(([key, scanMode]) => ({
      key,
      label: scanMode.label,
      zoneCount: scanMode.zones.length,
      default: scanMode.default,
    })),
    zones: ZONES,
    defaults: {
      application: 'bump-copper-pillar',
      scanMode: 'full-wafer',
      waferId: 'LOT2471-W07',
    },
    latencyBudgetMs: LATENCY_SLO.budgetMs,
  });
});

router.post('/api/04525b56/inspection-scan', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await runInspectionScan({
      application: body.application,
      scanMode: body.scanMode,
      waferId: body.waferId,
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
      code: error.code || 'INSPECTION_SCAN_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;
