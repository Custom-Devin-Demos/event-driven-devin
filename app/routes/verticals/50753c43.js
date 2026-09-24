const express = require('express');
const { checkOfferEligibility, CAMPAIGNS } = require('../../services/verticals/50753c43');

const router = express.Router();

router.get('/api/50753c43/campaigns', (_req, res) => {
  res.json({
    campaigns: Object.entries(CAMPAIGNS).map(([campaignCode, campaign]) => ({
      campaignCode,
      name: campaign.name,
      partner: campaign.partner,
      minSpend: campaign.minSpendAud,
      closesOn: campaign.closesOn,
    })),
  });
});

router.post('/api/50753c43/offer-eligibility', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await checkOfferEligibility({
      campaignCode: body.campaignCode,
      productCode: body.productCode,
      channel: body.channel,
      residencyStatus: body.residencyStatus,
      state: body.state,
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
      code: error.code || 'OFFER_ELIGIBILITY_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
