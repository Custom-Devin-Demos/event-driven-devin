const express = require('express');
const path = require('path');
const { PRODUCTION, getTimecardBatch, sendTimecardsToPayroll } = require('../../services/verticals/02a5e918');

const router = express.Router();
const PAGE = path.join(__dirname, '..', '..', 'public', 'verticals', '02a5e918.html');

for (const alias of ['/entertainment-partners', '/ep', '/ep-production-finance']) {
  router.get(alias, (_req, res) => res.sendFile(PAGE));
}

router.get('/api/02a5e918/timecards', (_req, res) => {
  res.json({ success: true, production: PRODUCTION, timecards: getTimecardBatch() });
});

router.post('/api/02a5e918/timecards/send-to-payroll', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await sendTimecardsToPayroll({
      batchId: body.batchId || PRODUCTION.payrollBatchId,
      timecardIds: body.timecardIds,
      devinUserId: typeof body.devinUserId === 'string' ? body.devinUserId.slice(0, 128) : undefined,
      devinOrgId: typeof body.devinOrgId === 'string' ? body.devinOrgId.slice(0, 128) : undefined,
      devinEmail: typeof body.devinEmail === 'string' ? body.devinEmail.slice(0, 254) : undefined,
    });
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'PAYROLL_BATCH_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
