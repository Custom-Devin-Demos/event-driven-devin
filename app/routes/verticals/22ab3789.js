const express = require('express');
const { submitContactRequest } = require('../../services/verticals/22ab3789');

const router = express.Router();

const MAX_IDENTITY_LENGTH = 200;

function identityField(value) {
  return typeof value === 'string' && value.length <= MAX_IDENTITY_LENGTH ? value : undefined;
}

router.post('/api/22ab3789/contact-requests', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await submitContactRequest({
      locale: body.locale,
      topic: body.topic,
      source: body.source,
      devinUserId: identityField(body.devinUserId),
      devinOrgId: identityField(body.devinOrgId),
      devinEmail: identityField(body.devinEmail),
    });
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'CONTACT_REQUEST_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;
