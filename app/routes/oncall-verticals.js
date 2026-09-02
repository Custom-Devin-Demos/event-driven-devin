const express = require('express');
const { processTransfer } = require('../services/oncall-verticals/banking');
const { upgradePlan } = require('../services/oncall-verticals/telco');
const { provisionLicense } = require('../services/oncall-verticals/hightech');
const { processClaim } = require('../services/oncall-verticals/insurance');
const { finalizeTranscript } = require('../services/oncall-verticals/voice');
const { runCompletion } = require('../services/oncall-verticals/inference');
const { processQuote } = require('../services/oncall-verticals/industrials');
const { isActiveSev1ProbeRef, isSev1DebugTimingsUnlocked } = require('../services/oncall');

const router = express.Router();

/**
 * POST /api/oncall/banking/transfer — process a fund transfer
 */
router.post('/api/oncall/banking/transfer', async (req, res) => {
  try {
    const result = await processTransfer({
      fromAccount: req.body.fromAccount || 'ACCT-1001',
      toAccount: req.body.toAccount || 'ACCT-1002',
      amount: req.body.amount || 500,
      accountTier: req.body.accountTier || 'standard',
      userId: req.body.userId || 'usr_banking_1',
    }, {
      synthetic: isActiveSev1ProbeRef(req.get('x-synthetic-monitor')),
      debugTimings: req.get('x-debug-timings') === '1'
        && isSev1DebugTimingsUnlocked('banking', req.get('x-synthetic-monitor')),
    });
    res.json(result);
  } catch (error) {
    const statusCode = error.code === 'INSUFFICIENT_FUNDS' ? 422 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'INTERNAL_ERROR',
      requestId: req.requestId,
    });
  }
});

/**
 * POST /api/oncall/telco/upgrade — upgrade a customer's plan
 */
router.post('/api/oncall/telco/upgrade', async (req, res) => {
  try {
    const result = await upgradePlan({
      accountId: req.body.accountId || 'CUST-3001',
      currentPlanCode: String(req.body.currentPlanCode || 'BASIC-12').toUpperCase(),
      targetPlanCode: String(req.body.targetPlanCode || 'FAMILY-PLUS-12').toUpperCase(),
      billingDay: req.body.billingDay || 15,
    }, { synthetic: isActiveSev1ProbeRef(req.get('x-synthetic-monitor')) });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'UPGRADE_FAILED',
      requestId: req.requestId,
    });
  }
});

/**
 * POST /api/oncall/licenses/provision — provision a new license
 */
router.post('/api/oncall/licenses/provision', async (req, res) => {
  try {
    const planName = (req.body.planName || 'Professional').trim();
    const result = await provisionLicense({
      orgName: req.body.orgName || 'New Customer Inc',
      planName,
      seats: Math.min(parseInt(req.body.seats, 10) || 10, 250),
      billingCycle: req.body.billingCycle || 'monthly',
    }, { synthetic: isActiveSev1ProbeRef(req.get('x-synthetic-monitor')) });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'PROVISION_FAILED',
      requestId: req.requestId,
    });
  }
});

/**
 * POST /api/oncall/voice/transcribe — finalize a dictated utterance
 */
router.post('/api/oncall/voice/transcribe', async (req, res) => {
  try {
    const result = await finalizeTranscript({
      workspace: req.body.workspace || 'Brightmail',
      dictionary: String(req.body.dictionary || 'general').toLowerCase(),
      utterance: String(req.body.utterance || '').slice(0, 4000),
    }, { synthetic: isActiveSev1ProbeRef(req.get('x-synthetic-monitor')) });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'TRANSCRIBE_FAILED',
      requestId: req.requestId,
    });
  }
});

/**
 * POST /api/oncall/inference/completions — run a chat completion.
 * With `stream: true` the response is server-sent events in the
 * OpenAI-compatible chunk shape, so a client can measure time to first token
 * rather than only total wall clock.
 */
router.post('/api/oncall/inference/completions', async (req, res) => {
  const payload = {
    model: String(req.body.model || 'deepseek-v3').toLowerCase(),
    deployment: req.body.deployment || 'chat-prod',
    prompt: String(req.body.prompt || '').slice(0, 8000),
    maxTokens: req.body.maxTokens,
  };
  const options = { synthetic: isActiveSev1ProbeRef(req.get('x-synthetic-monitor')) };

  if (req.body.stream !== true) {
    try {
      res.json(await runCompletion(payload, options));
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
        errorClass: error.name,
        code: error.code || 'COMPLETION_FAILED',
        requestId: req.requestId,
      });
    }
    return;
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  try {
    const result = await runCompletion(payload, {
      ...options,
      onFirstToken: (ttftMs) => send({ object: 'chat.completion.chunk', ttftMs }),
      onToken: (token) => send({
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: token } }],
      }),
    });
    send({
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: result.usage,
      ttftMs: result.ttftMs,
      tokensPerSecond: result.tokensPerSecond,
      id: result.id,
      model: result.model,
    });
    res.write('data: [DONE]\n\n');
  } catch (error) {
    send({ error: { message: error.message, code: error.code || 'COMPLETION_FAILED' } });
  }
  res.end();
});

/**
 * POST /api/oncall/insurance/claim — submit an insurance claim
 */
router.post('/api/oncall/insurance/claim', async (req, res) => {
  try {
    const result = await processClaim({
      policyId: req.body.policyId || 'POL-5001',
      claimType: req.body.claimType || 'collision',
      amount: req.body.amount || 5000,
      description: req.body.description || 'Vehicle damage from collision',
    }, { synthetic: isActiveSev1ProbeRef(req.get('x-synthetic-monitor')) });
    res.json(result);
  } catch (error) {
    const isTimeout = error.code === 'ADJUDICATION_TIMEOUT';
    res.status(isTimeout ? 504 : 500).json({
      success: false,
      error: isTimeout
        ? 'Claim submission timed out — please try again in a few minutes.'
        : error.message,
      errorClass: error.name,
      code: error.code || 'CLAIM_FAILED',
      requestId: req.requestId,
    });
  }
});

/**
 * POST /api/oncall/industrials/quote — generate an instant manufacturing quote
 */
router.post('/api/oncall/industrials/quote', async (req, res) => {
  try {
    const result = await processQuote({
      partNumber: req.body.partNumber || 'TM-DFM-4400',
      material: req.body.material || '7075-T6 Aluminum',
      toleranceClass: req.body.toleranceClass || 'Class B',
      quantity: req.body.quantity || 25,
      itarControlled: req.body.itarControlled === true,
      site: req.body.site || 'f3-mesa',
    }, {
      synthetic: isActiveSev1ProbeRef(req.get('x-synthetic-monitor')),
      debugTimings: req.get('x-debug-timings') === '1'
        && isSev1DebugTimingsUnlocked('industrials', req.get('x-synthetic-monitor')),
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'QUOTE_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
