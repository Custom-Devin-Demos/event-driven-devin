const express = require('express');
const { submitQuote, listBoms, getBom, BOMS } = require('../../services/verticals/c03fbe3d');

const router = express.Router();

function knownBom(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(BOMS, id);
}

router.get('/api/c03fbe3d/boms', (req, res) => {
  res.json({ success: true, ...listBoms() });
});

router.get('/api/c03fbe3d/boms/:id', (req, res) => {
  if (!knownBom(req.params.id)) {
    return res.status(404).json({ success: false, error: 'Unknown BOM', code: 'NOT_FOUND' });
  }
  return res.json({ success: true, bom: getBom(req.params.id) });
});

router.post('/api/c03fbe3d/quotes', async (req, res) => {
  const body = req.body || {};
  if (!knownBom(body.bomId)) {
    return res.status(400).json({ success: false, error: 'Unknown BOM', code: 'VALIDATION_ERROR' });
  }

  try {
    const result = await submitQuote({
      bomId: body.bomId,
      quoteReference: typeof body.quoteReference === 'string' ? body.quoteReference.slice(0, 80) : '',
      additionalInformation: typeof body.additionalInformation === 'string' ? body.additionalInformation.slice(0, 500) : '',
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
      requestId: req.requestId,
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: 'QUOTE_SUBMIT_FAILED',
      quoteRef: error.quoteRef,
      requestId: req.requestId,
    });
  }
});

module.exports = router;
