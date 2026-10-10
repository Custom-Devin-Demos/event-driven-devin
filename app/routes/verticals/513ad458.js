const express = require('express');
const {
  calculateTax,
  JURISDICTIONS,
  PRODUCT_CLASSES,
} = require('../../services/verticals/513ad458');
const { listInvoices } = require('../../services/verticals/513ad458-invoices');
const path = require('path');

const router = express.Router();

const billingPage = path.join(__dirname, '..', '..', 'public', 'verticals', '513ad458-billing.html');

router.get(['/vertex/dashboard/billing', '/513ad458/dashboard/billing'], (_req, res) => {
  res.sendFile(billingPage);
});

router.get('/api/513ad458/jurisdictions', (_req, res) => {
  res.json({
    jurisdictions: Object.entries(JURISDICTIONS).map(([code, jurisdiction]) => ({
      code,
      ...jurisdiction,
    })),
  });
});

router.get('/api/513ad458/product-classes', (_req, res) => {
  res.json({ productClasses: PRODUCT_CLASSES });
});

router.get('/api/513ad458/invoices', (_req, res) => {
  const { bookPeriod, invoices } = listInvoices();
  res.json({ bookPeriod, invoices });
});

router.post('/api/513ad458/calculate', async (req, res) => {
  const body = req.body || {};
  const valueOrDefault = (key, defaultValue) => (
    body[key] === undefined ? defaultValue : body[key]
  );

  try {
    const result = await calculateTax({
      companyCode: valueOrDefault('companyCode', 'ACME-US-01'),
      customerCode: valueOrDefault('customerCode', 'CUST-100482'),
      jurisdiction: valueOrDefault('jurisdiction', 'PA'),
      productClass: valueOrDefault('productClass', 'SAAS'),
      amount: valueOrDefault('amount', 125000),
      quantity: valueOrDefault('quantity', 1),
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'TAX_CALCULATION_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
