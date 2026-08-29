const express = require('express');
const { submitAppointmentInquiry, VISIT_TYPES } = require('../../services/verticals/6469d508');

const router = express.Router();

/**
 * GET /api/6469d508/visit-types — visit types open for appointment inquiries
 */
router.get('/api/6469d508/visit-types', (_req, res) => {
  res.json({
    visitTypes: Object.values(VISIT_TYPES).map((entry) => ({
      code: entry.code,
      name: entry.name,
      durationMinutes: entry.durationMinutes,
    })),
  });
});

/**
 * POST /api/6469d508/inquiry — submit an appointment inquiry
 */
router.post('/api/6469d508/inquiry', async (req, res) => {
  try {
    const confirmation = await submitAppointmentInquiry({
      visitType: req.body.visitType || 'primary_care',
      zipCode: req.body.zipCode || '10029',
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(confirmation);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'INQUIRY_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
