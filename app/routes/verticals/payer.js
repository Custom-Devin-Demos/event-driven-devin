const express = require('express');
const logger = require('../../telemetry/logger');
const { incrementMetric } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const {
  adjudicateClaim,
  generateMemberIdCard,
  MEMBERS,
  FORMULARY,
  REJECTION_SERIES,
} = require('../../services/verticals/payer');

const router = express.Router();

/**
 * GET /api/payer/members — member roster for the plan-year selector
 */
router.get('/api/payer/members', (_req, res) => {
  const members = Object.entries(MEMBERS).map(([id, member]) => ({
    id,
    name: member.name,
    planId: member.planId,
  }));
  res.json({ members, formulary: FORMULARY });
});

/**
 * GET /api/payer/id-card/:memberId — member digital ID card as printed for the plan year
 */
router.get('/api/payer/id-card/:memberId', (req, res) => {
  let card;
  try {
    card = generateMemberIdCard(req.params.memberId);
  } catch (error) {
    incrementMetric('member_id_card.config_error', {
      route: '/api/payer/id-card',
      code: error.code || 'unknown',
    });
    logger.error('Member ID card could not be generated', {
      memberId: req.params.memberId,
      error: error.message,
      code: error.code,
      service: 'payer-api',
    });
    Sentry.captureException(error, {
      tags: { route: '/api/payer/id-card', service: 'payer-api', code: error.code || 'unknown' },
      extra: { memberId: req.params.memberId },
    });
    return res.status(500).json({ success: false, error: error.message, code: error.code });
  }
  if (!card) {
    return res.status(404).json({ success: false, error: 'Member not found' });
  }
  res.json(card);
});

/**
 * GET /api/payer/rejection-series — daily pharmacy claim rejection rate across the plan-year boundary
 */
router.get('/api/payer/rejection-series', (_req, res) => {
  res.json({ series: REJECTION_SERIES });
});

/**
 * POST /api/payer/pharmacy-claim — adjudicate an NCPDP claim submitted at the counter
 */
router.post('/api/payer/pharmacy-claim', async (req, res) => {
  try {
    const result = await adjudicateClaim({
      memberId: req.body.memberId || 'MEM-100234',
      ndc: req.body.ndc || '00078-0592-15',
      pharmacyNpi: req.body.pharmacyNpi || '1487654321',
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    if (error.code === 'PLAN_CONFIG_MISSING') {
      return res.status(500).json({
        success: false,
        error: error.message,
        code: error.code,
        requestId: req.requestId,
      });
    }
    if (error.code === 'DRUG_NOT_ON_FORMULARY') {
      return res.status(400).json({
        success: false,
        error: error.message,
        code: error.code,
        requestId: req.requestId,
      });
    }
    if (error.code === 'MEMBER_NOT_FOUND') {
      return res.status(404).json({
        success: false,
        error: error.message,
        code: error.code,
        requestId: req.requestId,
      });
    }
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.rejectCode ? 'CLAIM_REJECTED' : 'ADJUDICATION_FAILED',
      rejectCode: error.rejectCode,
      rejectReason: error.rejectReason,
      submittedBin: error.submittedBin,
      requestId: req.requestId,
    });
  }
});

module.exports = router;
