const express = require('express');
const { checkoutUpgrade } = require('../../services/verticals/tmobile');

const router = express.Router();

/**
 * POST /api/tmobile/upgrade/checkout — place a device upgrade order for a line.
 *
 * Called by the T-Life iOS app (COG-GTM/ios-demos, apps/1735ce0a); there is no
 * web page for this vertical.
 */
router.post('/api/tmobile/upgrade/checkout', async (req, res) => {
  try {
    const result = await checkoutUpgrade({
      accountNumber: req.body.accountNumber,
      lineNumber: req.body.lineNumber,
      deviceSku: req.body.deviceSku,
      tradeIn: req.body.tradeIn,
      client: req.get('X-TMobile-Client'),
      demoToken: req.get('X-TMobile-Demo-Token'),
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.name || 'Error',
      message: error.message,
      code: error.code || 'UPGRADE_CHECKOUT_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
