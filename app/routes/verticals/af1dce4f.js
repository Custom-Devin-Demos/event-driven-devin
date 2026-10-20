const express = require('express');
const { generateFleetHealthReport, resetWorkbench, getOverview } = require('../../services/verticals/af1dce4f');

const router = express.Router();

router.get('/api/af1dce4f/overview', (_req, res) => {
  res.json(getOverview());
});

router.post('/api/af1dce4f/fleet-health/report', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await generateFleetHealthReport({
      customerId: typeof body.customerId === 'string' ? body.customerId : '',
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(error.status === 400 ? 400 : 500).json({ error: error.message, errorType: error.name });
  }
});

router.post('/api/af1dce4f/fleet-health/reset', (_req, res) => {
  res.json(resetWorkbench());
});

module.exports = router;
