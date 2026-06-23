const express = require('express');
const { processReferral, SPECIALISTS, REFERRALS } = require('../../services/verticals/athenahealth');

const router = express.Router();

/**
 * GET /api/athenahealth/specialists — returns specialist directory and recent referrals
 */
router.get('/api/athenahealth/specialists', (_req, res) => {
  res.json({ specialists: SPECIALISTS, recentReferrals: REFERRALS });
});

/**
 * POST /api/athenahealth/referral — submit a specialist referral
 */
router.post('/api/athenahealth/referral', async (req, res) => {
  try {
    const result = await processReferral({
      patientMrn: req.body.patientMrn || 'ATH-2026-08471',
      referringProvider: req.body.referringProvider || 'DR-PCP-101',
      specialty: req.body.specialty || 'cardiology',
      specialistId: req.body.specialistId || 'DR-CARD-401',
      priority: req.body.priority || 'routine',
      authNumber: req.body.authNumber || 'AUTH-2026-55891',
      diagnosisCode: req.body.diagnosisCode || 'I25.10',
      clinicalNotes: req.body.clinicalNotes || '',
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'REFERRAL_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
