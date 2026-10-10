const express = require('express');
const { submitSupportTicket } = require('../../services/verticals/50a88f70');

const router = express.Router();

/**
 * POST /api/50a88f70/support-ticket — submit an Epic Games Player Support request
 */
router.post('/api/50a88f70/support-ticket', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await submitSupportTicket({
      product: body.product || 'fortnite',
      platform: body.platform || 'pc',
      topic: body.topic || 'item-shop-missing-purchase',
      displayName: body.displayName,
      email: body.email,
      description: body.description,
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
      code: error.code || 'SUPPORT_TICKET_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;
