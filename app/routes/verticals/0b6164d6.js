const express = require('express');
const { renderClusterUi, CLUSTERS } = require('../../services/verticals/0b6164d6');

const router = express.Router();

/**
 * GET /api/0b6164d6/clusters — clusters listed on the workspace Compute page
 */
router.get('/api/0b6164d6/clusters', (_req, res) => {
  res.json({ clusters: CLUSTERS });
});

/**
 * POST /api/0b6164d6/cluster-ui — render the Spark UI panel for one cluster
 */
router.post('/api/0b6164d6/cluster-ui', async (req, res) => {
  try {
    const body = req.body || {};
    const snapshot = await renderClusterUi({
      clusterId: body.clusterId,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(snapshot);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'CLUSTER_UI_RENDER_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
