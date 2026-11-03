const express = require('express');
const { submitPayroll, listProjects, PROJECTS } = require('../../services/verticals/844f1b1f');

const router = express.Router();

router.get('/api/844f1b1f/projects', (req, res) => {
  res.json({ success: true, projects: listProjects() });
});

router.post('/api/844f1b1f/payroll/submit', async (req, res) => {
  const body = req.body || {};
  const projectId = typeof body.projectId === 'string' ? body.projectId : '';
  if (!Object.prototype.hasOwnProperty.call(PROJECTS, projectId)) {
    return res.status(400).json({ success: false, error: 'Unknown project', code: 'VALIDATION_ERROR' });
  }
  if (body.certified !== true) {
    return res.status(400).json({ success: false, error: 'Superintendent certification is required', code: 'VALIDATION_ERROR' });
  }

  try {
    const result = await submitPayroll({
      projectId,
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
      code: 'PAYROLL_SUBMIT_FAILED',
      payrollRef: error.payrollRef,
      requestId: req.requestId,
    });
  }
});

module.exports = router;
