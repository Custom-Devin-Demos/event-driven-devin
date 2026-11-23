const express = require('express');
const { downloadEdition, listEditions, getEdition, resetDownloads, EDITIONS } = require('../../services/verticals/43e4e1fb');

const router = express.Router();

function knownEdition(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(EDITIONS, id);
}

// `reports: 'off'` (or `?reports=off` on the page) keeps the planted failure but skips Sentry/Slack/Devin; `x-synthetic` is local-only.
const alertsSuppressed = (req) => (req.body && req.body.reports === 'off')
  || (Boolean(req.headers['x-synthetic']) && process.env.NODE_ENV !== 'production');

function demoId(req) {
  const id = req.get('x-demo-id');
  return typeof id === 'string' ? id.slice(0, 64) : '';
}

router.get('/api/43e4e1fb/editions', (req, res) => {
  res.json({ success: true, ...listEditions(demoId(req)) });
});

router.get('/api/43e4e1fb/editions/:id', (req, res) => {
  if (!knownEdition(req.params.id)) {
    return res.status(404).json({ success: false, error: 'Unknown edition', code: 'NOT_FOUND' });
  }
  return res.json({ success: true, edition: getEdition(req.params.id, demoId(req)) });
});

router.post('/api/43e4e1fb/editions/reset', (req, res) => {
  resetDownloads(demoId(req));
  res.json({ success: true });
});

router.post('/api/43e4e1fb/editions/:id/download', async (req, res) => {
  if (!knownEdition(req.params.id)) {
    return res.status(400).json({ success: false, error: 'Unknown edition', code: 'VALIDATION_ERROR' });
  }
  const body = req.body || {};
  try {
    const result = await downloadEdition({
      editionId: req.params.id,
      demoId: demoId(req),
      alertsSuppressed: alertsSuppressed(req),
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
      requestId: req.requestId,
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: 'EDITION_DOWNLOAD_FAILED',
      jobId: error.jobId,
      requestId: req.requestId,
    });
  }
});

module.exports = router;
