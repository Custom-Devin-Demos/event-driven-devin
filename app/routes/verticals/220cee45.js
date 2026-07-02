const express = require('express');
const { processOrder, CATALOG, DISTRIBUTION_CENTERS } = require('../../services/verticals/220cee45');

const router = express.Router();

/**
 * GET /api/220cee45/catalog — returns the lab product catalog
 */
router.get('/api/220cee45/catalog', (_req, res) => {
  res.json({ products: CATALOG });
});

/**
 * GET /api/220cee45/facilities — returns distribution center statuses
 */
router.get('/api/220cee45/facilities', (_req, res) => {
  res.json({ facilities: DISTRIBUTION_CENTERS });
});

/**
 * POST /api/220cee45/order — submit a lab supplies purchase order
 */
router.post('/api/220cee45/order', async (req, res) => {
  try {
    const result = await processOrder({
      poNumber: req.body.poNumber || 'PO-784512',
      accountId: req.body.accountId || 'ACCT-TF-90213',
      distributionCenter: req.body.distributionCenter || 'DC-FRMD',
      items: req.body.items || [
        { catalogNo: '11668019', quantity: 2 },
        { catalogNo: 'A14906', quantity: 1 },
        { catalogNo: '15140122', quantity: 4 },
      ],
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
      code: error.code || 'ORDER_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
