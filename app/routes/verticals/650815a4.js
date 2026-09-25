const express = require('express');
const { submitDemoRequest, PRODUCTS, REGIONS } = require('../../services/verticals/650815a4');

const router = express.Router();

router.get('/api/650815a4/products', (req, res) => {
  res.json({
    products: Object.entries(PRODUCTS).map(([key, p]) => ({
      key,
      label: p.label,
      tagline: p.tagline,
    })),
    regions: Object.entries(REGIONS).map(([key, r]) => ({
      key,
      label: r.label,
    })),
  });
});

router.post('/api/650815a4/demo-request', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await submitDemoRequest({
      workEmail: body.workEmail,
      firstName: body.firstName,
      lastName: body.lastName,
      company: body.company,
      role: body.role,
      product: body.product,
      region: body.region,
      message: body.message,
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
      code: error.code || 'DEMO_REQUEST_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;
