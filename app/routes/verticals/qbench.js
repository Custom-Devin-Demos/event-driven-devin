const express = require('express');
const path = require('path');
const { generateCertificate, SAMPLES, TEST_PANELS } = require('../../services/verticals/qbench');

const router = express.Router();

router.get('/qbench', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', 'qbench.html'));
});

router.get('/api/qbench/samples', (_req, res) => {
  res.json({
    samples: Object.values(SAMPLES).map((sample) => ({
      sampleId: sample.sampleId,
      client: sample.client,
      matrix: sample.matrix,
      batchId: sample.batchId,
      receivedAt: sample.receivedAt,
      panelCode: sample.panelCode,
      panelLabel: TEST_PANELS[sample.panelCode].label,
      method: TEST_PANELS[sample.panelCode].method,
      results: sample.results,
    })),
  });
});

router.post('/api/qbench/coa', async (req, res) => {
  const body = req.body || {};
  const valueOrDefault = (key, fallback) => (
    Object.prototype.hasOwnProperty.call(body, key) ? body[key] : fallback
  );

  try {
    const certificate = await generateCertificate({
      sampleId: valueOrDefault('sampleId', 'S-260911-0042'),
      reviewedBy: valueOrDefault('reviewedBy', 'M. Okafor'),
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(certificate);
  } catch (error) {
    if (error.statusCode === 400 || error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: error.message,
        errorClass: error.name,
        code: error.code || 'INVALID_SAMPLE',
        requestId: req.requestId,
      });
    }

    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'COA_GENERATION_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
