const path = require('path');
const express = require('express');
const {
  getOutageStatus,
  resetOutageStatus,
  searchServicePoints,
  LOOKUP_HISTORY,
  SYSTEM_SITUATION,
} = require('../../services/verticals/b6f570dc');

const router = express.Router();
const PAGE = path.join(__dirname, '../../public/verticals/b6f570dc.html');

router.get(['/b6f570dc/outage-status', '/b6f570dc/outage-status/'], (_req, res) => {
  res.sendFile(PAGE);
});

router.get('/api/b6f570dc/addresses', (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q : '';
  res.json({ query, matches: searchServicePoints(query) });
});

router.get('/api/b6f570dc/situation', (_req, res) => {
  res.json({ system: SYSTEM_SITUATION, recentLookups: LOOKUP_HISTORY, asOf: new Date().toISOString() });
});

router.post('/api/b6f570dc/outage-status', async (req, res) => {
  try {
    const result = await getOutageStatus({
      address: req.body.address || '300 LAKESIDE DR OAKLAND CA 94612',
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
      sourcePage: req.body.sourcePage,
    });
    res.json(result);
  } catch (error) {
    if (error.statusCode === 404) {
      res.status(404).json({
        success: false,
        error: error.message,
        errorClass: error.name,
        code: 'NOT_FOUND',
        requestId: req.requestId,
      });
      return;
    }
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: 'INTERNAL_ERROR',
      requestId: req.requestId,
    });
  }
});

router.post('/api/b6f570dc/outage-status/reset', (_req, res) => {
  res.json(resetOutageStatus());
});

module.exports = router;
