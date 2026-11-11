const express = require('express');
const {
  getInbox,
  sendBusinessSms,
  listIncidents,
  getFeatureRequest,
  listFeatureRequests,
  listRecordings,
  createVoiceQaRequest,
} = require('../../services/verticals/cbe0ee4c');

const router = express.Router();

const clip = (value, max) => (typeof value === 'string' ? value.slice(0, max) : undefined);

function devinFields(body) {
  return {
    devinUserId: clip(body.devinUserId, 128),
    devinOrgId: clip(body.devinOrgId, 128),
    devinEmail: clip(body.devinEmail, 254),
  };
}

function sendError(res, req, error, fallbackCode) {
  res.status(error.statusCode || 500).json({
    success: false,
    error: error.message,
    errorClass: error.name,
    code: error.code || fallbackCode,
    messageId: error.messageId,
    jira: error.jira || null,
    requestId: req.requestId,
  });
}

router.get('/api/cbe0ee4c/inbox', (_req, res) => {
  res.json({ success: true, ...getInbox() });
});

router.post('/api/cbe0ee4c/sms', async (req, res) => {
  const body = req.body || {};
  try {
    res.json(await sendBusinessSms({
      fromNumberId: clip(body.fromNumberId, 32),
      conversationId: clip(body.conversationId, 64),
      text: clip(body.text, 2000),
      ...devinFields(body),
    }));
  } catch (error) {
    sendError(res, req, error, 'SMS_SEND_FAILED');
  }
});

router.get('/api/cbe0ee4c/incidents', (_req, res) => {
  res.json({ success: true, incidents: listIncidents() });
});

router.get('/api/cbe0ee4c/feature-requests', (_req, res) => {
  res.json({ success: true, ...listFeatureRequests() });
});

router.get('/api/cbe0ee4c/recordings', (_req, res) => {
  res.json({ success: true, recordings: listRecordings() });
});

router.post('/api/cbe0ee4c/recordings/:id/qa', async (req, res) => {
  const body = req.body || {};
  try {
    const request = await createVoiceQaRequest({ recordingId: clip(req.params.id, 64), name: clip(body.name, 80), ...devinFields(body) });
    res.json({ success: true, request });
  } catch (error) {
    sendError(res, req, error, 'VOICE_QA_FAILED');
  }
});

router.get('/api/cbe0ee4c/feature-requests/:id', async (req, res) => {
  const request = await getFeatureRequest(req.params.id);
  if (!request) {
    res.status(404).json({ success: false, error: 'Feature request not found.' });
    return;
  }
  res.json({ success: true, request });
});

module.exports = router;
