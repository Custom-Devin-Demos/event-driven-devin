const express = require('express');
const path = require('path');
const { ACCOUNT_PRODUCTS, openAccount } = require('../../services/verticals/sabadell');

const router = express.Router();

router.get('/sabadell', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', 'sabadell.html'));
});

router.get('/api/sabadell/products', (_req, res) => {
  res.json({
    products: Object.entries(ACCOUNT_PRODUCTS).map(([code, product]) => ({
      code,
      label: product.label,
      name: product.label,
      maxFirstYearEur: product.maxFirstYearEur,
    })),
  });
});

router.post('/api/sabadell/open-account', async (req, res) => {
  try {
    const result = await openAccount({
      product: req.body.product || 'cuenta-online',
      applicantName: req.body.applicantName,
      documentId: req.body.documentId,
      monthlyIncomeEur: req.body.monthlyIncomeEur,
      payrollDirectDeposit: req.body.payrollDirectDeposit,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(error.code === 'VALIDATION_ERROR' ? 400 : 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'ACCOUNT_OPENING_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
