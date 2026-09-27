const express = require('express');
const { sendMessage, CONTACTS, MESSAGE_TYPES, ENCOUNTERS } = require('../../services/verticals/ps');

const router = express.Router();

/**
 * GET /api/ps/directory — care team contacts, message types and patient encounters
 */
router.get('/api/ps/directory', (_req, res) => {
  res.json({ contacts: CONTACTS, messageTypes: MESSAGE_TYPES, encounters: ENCOUNTERS });
});

/**
 * POST /api/ps/messages — send a secure clinical message
 */
router.post('/api/ps/messages', async (req, res) => {
  try {
    const result = await sendMessage({
      participantIds: req.body.participantIds,
      messageType: req.body.messageType,
      encounterId: req.body.encounterId,
      message: req.body.message,
      callbackNumber: req.body.callbackNumber,
      attachments: req.body.attachments,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'SEND_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
