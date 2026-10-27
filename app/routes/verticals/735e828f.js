const express = require('express');
const { submitEnquiry } = require('../../services/verticals/735e828f');

const router = express.Router();

/**
 * POST /api/735e828f/enquiry — BHP "Contact us" Enquiry/Feedback form
 */
router.post('/api/735e828f/enquiry', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await submitEnquiry({
      topic: body.topic || 'potash',
      subject: body.subject || 'community',
      fullName: body.fullName,
      email: body.email,
      confirmEmail: body.confirmEmail,
      country: body.country,
      phone: body.phone,
      message: body.message,
      acceptTerms: body.acceptTerms,
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
      code: error.code || 'ENQUIRY_SUBMISSION_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;
