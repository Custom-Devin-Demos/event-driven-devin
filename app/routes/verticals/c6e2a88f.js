const express = require('express');
const {
  getReviewQueue,
  getExceptionRegister,
  getDecisionRecord,
  recordDecision,
} = require('../../services/verticals/c6e2a88f');

const router = express.Router();

function sendError(req, res, error, fallbackCode) {
  res.status(error.statusCode || 500).json({
    success: false,
    error: error.message,
    errorClass: error.name,
    code: error.code || fallbackCode,
    requestId: req.requestId,
  });
}

/** GET /api/c6e2a88f/review-queue — submissions awaiting scoring, board or decision */
router.get('/api/c6e2a88f/review-queue', (_req, res) => {
  res.json(getReviewQueue());
});

/** GET /api/c6e2a88f/exceptions — time-limited exceptions to published standards */
router.get('/api/c6e2a88f/exceptions', (_req, res) => {
  res.json(getExceptionRegister());
});

/** GET /api/c6e2a88f/decisions/:reference — decision record for a submission */
router.get('/api/c6e2a88f/decisions/:reference', (req, res) => {
  try {
    res.json(getDecisionRecord(req.params.reference));
  } catch (error) {
    sendError(req, res, error, 'DECISION_RECORD_FAILED');
  }
});

/** POST /api/c6e2a88f/decisions — record the board's decision as an ADR */
router.post('/api/c6e2a88f/decisions', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await recordDecision({
      reference: body.reference,
      outcome: body.outcome,
      title: body.title,
      rationale: body.rationale,
      conditions: body.conditions,
      standards: body.standards,
      chair: body.chair,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    sendError(req, res, error, 'RECORD_DECISION_FAILED');
  }
});

module.exports = router;
