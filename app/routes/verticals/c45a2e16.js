const express = require('express');
const fs = require('fs');
const path = require('path');
const { confirmCheckout, getTenant } = require('../../services/verticals/c45a2e16');

const router = express.Router();

const PAGE = path.join(__dirname, '..', '..', 'public', 'verticals', 'c45a2e16.html');

async function handleCheckout(req, res) {
  const body = req.body || {};

  try {
    const result = await confirmCheckout({
      tenant: req.params.tenant,
      orderRef: body.orderRef,
      plan: body.plan,
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
      code: error.code || 'CHECKOUT_FAILED',
      requestId: req.requestId,
    });
  }
}

// Every demo owner gets their own unlisted URL: /c45a2e16/<tenant>. The bare
// slug is served by the vertical registry but carries no tenant, so its form
// refuses to submit rather than running against someone else's demo state.
// Each tenant's order is written into its own page so a second owner never
// sees (or submits) another owner's basket.
function renderPage(tenant) {
  const { orderRef, merchant, item, amount, currency } = tenant.order;
  const order = JSON.stringify({ orderRef, merchant, item, amount, currency }).replace(/</g, '\\u003c');
  return fs.readFileSync(PAGE, 'utf8').replace('/*__TENANT_ORDER__*/null', order);
}

router.get('/c45a2e16/:tenant', (req, res, next) => {
  const tenant = getTenant(req.params.tenant);
  if (!tenant) return next();
  res.set('Cache-Control', 'no-store').type('html').send(renderPage(tenant));
});

router.post('/api/c45a2e16/:tenant/checkout', handleCheckout);

module.exports = router;
module.exports.renderPage = renderPage;
