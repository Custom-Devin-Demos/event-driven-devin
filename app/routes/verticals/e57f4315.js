const express = require('express');
const { listBrandDirectory } = require('../../services/verticals/e57f4315');

const router = express.Router();

router.post('/api/e57f4315/brand-directory', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await listBrandDirectory({
      region: body.region,
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
      code: error.code || 'BRAND_DIRECTORY_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
