const express = require('express');
const { registerForClass, CLASS_CATALOG } = require('../../services/verticals/dae1efec');

const router = express.Router();

/**
 * GET /api/dae1efec/classes — education classes open for registration
 */
router.get('/api/dae1efec/classes', (_req, res) => {
  res.json({
    classes: CLASS_CATALOG.map((entry) => ({
      classCode: entry.classCode,
      title: entry.title,
      durationMinutes: entry.durationMinutes,
      format: entry.format,
    })),
  });
});

/**
 * POST /api/dae1efec/class-registration — register for a no-cost class
 */
router.post('/api/dae1efec/class-registration', async (req, res) => {
  try {
    const confirmation = await registerForClass({
      classCode: req.body.classCode || 'ks-intro-101',
      format: req.body.format || 'in_person',
      zipCode: req.body.zipCode || '80202',
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
      code: error.code || 'REGISTRATION_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
