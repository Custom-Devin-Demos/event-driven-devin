const express = require('express');
const path = require('path');
const {
  openPortalSession,
  FUNDS,
  INVESTORS,
  REPORTING_CALENDAR,
  DEFAULT_INVESTOR_ID,
} = require('../../services/verticals/dea6254c');

const router = express.Router();

router.get('/dea6254c', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', 'dea6254c.html'));
});

router.get('/api/dea6254c/investor', (req, res) => {
  const investor = INVESTORS[req.query.investorId || DEFAULT_INVESTOR_ID];
  if (!investor) {
    return res.status(404).json({ success: false, error: 'Investor not found' });
  }
  res.json({
    investor,
    reportingCalendar: REPORTING_CALENDAR,
    funds: Object.values(FUNDS).map((fund) => ({
      code: fund.code,
      name: fund.name,
      strategy: fund.strategy,
      navFrequency: fund.navFrequency,
      shareClasses: Object.keys(fund.shareClasses),
    })),
  });
});

router.post('/api/dea6254c/portal-session', async (req, res) => {
  const body = req.body || {};

  try {
    const result = await openPortalSession({
      investorId: body.investorId || DEFAULT_INVESTOR_ID,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    if (error.statusCode === 400 || error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: error.message,
        errorClass: error.name,
        code: error.code || 'INVALID_PORTAL_REQUEST',
        requestId: error.requestId || req.requestId,
      });
    }

    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: 'PORTAL_SESSION_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;
