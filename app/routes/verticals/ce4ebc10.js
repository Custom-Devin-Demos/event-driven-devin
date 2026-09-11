const express = require('express');
const {
  publishPricing,
  PRICING_MODELS,
  ACCOUNTS,
  REV_REC_TREATMENTS,
} = require('../../services/verticals/ce4ebc10');

const router = express.Router();

router.get('/api/ce4ebc10/catalog', (_req, res) => {
  res.json({
    models: Object.entries(PRICING_MODELS).map(([code, model]) => ({ code, ...model })),
    accounts: Object.entries(ACCOUNTS).map(([accountId, account]) => ({ accountId, ...account })),
    treatments: Object.keys(REV_REC_TREATMENTS),
  });
});

function numberField(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

router.post('/api/ce4ebc10/publish-pricing', async (req, res) => {
  const body = req.body || {};
  const pricingModel = body.pricingModel || 'hybrid';
  const accountId = body.accountId || 'acct-4471';
  const ratePerToken = numberField(body.ratePerToken, 0.002);
  const usageTokens = numberField(body.usageTokens, 1240000);
  const committedSpend = numberField(body.committedSpend, ACCOUNTS[accountId] ? ACCOUNTS[accountId].committedSpend : 50000);

  if (!Object.hasOwn(PRICING_MODELS, pricingModel)) {
    return res.status(400).json({ success: false, error: `Unknown pricing model: ${pricingModel}`, code: 'VALIDATION_ERROR' });
  }
  if (!Object.hasOwn(ACCOUNTS, accountId)) {
    return res.status(400).json({ success: false, error: `Unknown account: ${accountId}`, code: 'VALIDATION_ERROR' });
  }
  if (ratePerToken === null || ratePerToken <= 0) {
    return res.status(400).json({ success: false, error: 'ratePerToken must be a positive number', code: 'VALIDATION_ERROR' });
  }
  if (usageTokens === null || !Number.isSafeInteger(usageTokens) || usageTokens < 0) {
    return res.status(400).json({ success: false, error: 'usageTokens must be a non-negative safe integer', code: 'VALIDATION_ERROR' });
  }
  if (committedSpend === null || !Number.isSafeInteger(committedSpend) || committedSpend < 0) {
    return res.status(400).json({ success: false, error: 'committedSpend must be a non-negative integer', code: 'VALIDATION_ERROR' });
  }

  try {
    const result = await publishPricing({
      pricingModel,
      accountId,
      ratePerToken,
      usageTokens,
      committedSpend,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'PRICING_PUBLISH_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
