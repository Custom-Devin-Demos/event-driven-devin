const express = require('express');
const { retireNodeGroup, resetCluster, getClusterState } = require('../../services/verticals/e63d468c');

const router = express.Router();

router.get('/api/e63d468c/cluster', (_req, res) => {
  res.json(getClusterState());
});

router.post('/api/e63d468c/nodegroups/retire', async (req, res) => {
  try {
    const result = await retireNodeGroup({
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      requestId: req.requestId,
      ...getClusterState(),
    });
  }
});

router.post('/api/e63d468c/nodegroups/retire/reset', (_req, res) => {
  res.json(resetCluster());
});

module.exports = router;
