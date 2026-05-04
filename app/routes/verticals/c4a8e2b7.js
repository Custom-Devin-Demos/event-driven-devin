const express = require('express');
const router = express.Router();
const { processTransferLookup, TRANSFERS, RECENT_WIRES } = require('../../services/verticals/c4a8e2b7');

router.get('/api/c4a8e2b7/accounts', (_req, res) => {
  res.json({
    transfers: TRANSFERS.map((t) => ({
      ref: t.ref,
      beneficiary: t.beneficiary,
      status: t.status,
    })),
    recentWires: RECENT_WIRES,
  });
});

router.post('/api/c4a8e2b7/transfer', async (req, res) => {
  try {
    const result = await processTransferLookup(req.body);
    res.json(result);
  } catch (error) {
    res.status(error.code === 'TRANSFER_NOT_FOUND' ? 404 : 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
    });
  }
});

module.exports = router;
