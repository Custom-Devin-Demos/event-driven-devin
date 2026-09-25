const express = require('express');
const path = require('path');
const { applyRebalance, CLUSTERS, QUEUES } = require('../../services/verticals/bd631c20');

const router = express.Router();

function sendPage(_req, res) {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', 'bd631c20.html'));
}

router.get('/bd631c20', sendPage);
router.get('/bloomberg', sendPage);

router.get('/api/bd631c20/cluster', (_req, res) => {
  res.json({
    clusters: Object.values(CLUSTERS),
    queues: Object.values(QUEUES).map((queue) => ({
      queueUri: queue.queueUri,
      name: queue.name,
      domain: queue.domain,
      mode: queue.mode,
      partitions: queue.partitions,
      storageTier: queue.storageTier,
      storageTierLabel: queue.storageTierLabel,
      consumers: queue.consumers,
      backlogBytes: queue.backlogBytes,
      producerRateMsgsSec: queue.producerRateMsgsSec,
    })),
  });
});

router.post('/api/bd631c20/rebalance', async (req, res) => {
  const body = req.body || {};
  const valueOrDefault = (key, fallback) => (
    Object.prototype.hasOwnProperty.call(body, key) ? body[key] : fallback
  );

  const rebalanceData = {
    clusterId: valueOrDefault('clusterId', 'bmq-prod-east'),
    queueUri: valueOrDefault('queueUri', 'bmq://bmq.prod.east/market-data.ticks'),
    targetPartitions: valueOrDefault('targetPartitions', 6),
    devinUserId: body.devinUserId,
    devinOrgId: body.devinOrgId,
    devinEmail: body.devinEmail,
  };

  try {
    const plan = await applyRebalance(rebalanceData);
    res.json(plan);
  } catch (error) {
    if (error.statusCode === 400 || error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: error.message,
        errorClass: error.name,
        code: error.code || 'INVALID_REBALANCE',
        requestId: req.requestId,
      });
    }

    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'REBALANCE_PLANNING_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
