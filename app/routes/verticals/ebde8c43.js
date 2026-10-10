const express = require('express');
const path = require('path');
const { releaseHeldPayment, getTenant } = require('../../services/verticals/ebde8c43');

const router = express.Router();

const PAGE = path.join(__dirname, '..', '..', 'public', 'verticals', 'ebde8c43.html');

async function handleRelease(req, res) {
  const body = req.body || {};

  try {
    const result = await releaseHeldPayment({
      tenant: req.params.tenant,
      alertId: body.alertId,
      amount: body.amount,
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
      code: error.code || 'PAYMENT_RELEASE_FAILED',
      requestId: req.requestId,
    });
  }
}

// Every demo owner gets their own unlisted URL: /ebde8c43/<tenant>. The bare
// slug is served by the vertical registry but carries no tenant, so its form
// refuses to submit rather than running against someone else's demo state.
router.get('/ebde8c43/:tenant', (req, res, next) => {
  if (!getTenant(req.params.tenant)) return next();
  res.sendFile(PAGE);
});

router.post('/api/ebde8c43/:tenant/release', handleRelease);

module.exports = router;
