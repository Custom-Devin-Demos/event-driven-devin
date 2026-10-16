const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const fixtures = require('./e7fd3fee-erica-fixtures.json');

const SERVICE = 'erica-svc';
const ROUTE = '/api/e7fd3fee/erica/chat';
const PAGE = '/e7fd3fee/olb';
const CUSTOMER_REF = 'cust_tok_7f3a91c2';
const SUPPORT_LINE = '800.732.9194';
const MODEL = Object.freeze({ inventory_id: 'MRM-ERICA-NLU-0042', name: 'erica-intent-rules', version: '3.8.1' });
const PROMPT_TEMPLATE = Object.freeze({ id: 'erica.card_dispute', version: '2.4.0' });

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'Erica threw while filing a card dispute after the customer confirmed "Lock card and dispute charge" in Online Banking. '
    + 'Investigate `app/services/verticals/e7fd3fee-erica.js` (`resolveNetworkReason` / `buildDisputeFiling`), fix the root cause, '
    + 'add a regression test, and open a PR against `main`.',
].join('\n');

/** Maps Erica's internal dispute reasons to card-network reason codes. */
const NETWORK_REASON_CODES = {
  visa: {
    unrecognized_charge: { code: '10.4', label: 'Other Fraud — Card-Absent Environment' },
    duplicate_charge: { code: '12.6.1', label: 'Duplicate Processing' },
  },
  mastercard: {
    unrecognized_transaction: { code: '4837', label: 'No Cardholder Authorization' },
    duplicate_charge: { code: '4834', label: 'Point-of-Interaction Error' },
  },
};

const stages = new Map();

function hash(value) {
  return `sha256:${crypto.createHash('sha256').update(`erica-demo:${value}`).digest('hex').slice(0, 24)}`;
}

function redact(text) {
  return String(text || '')
    .replace(/\b\d{12,19}\b/g, '[CARD]')
    .replace(/\b\d{3}-?\d{2}-?\d{4}\b/g, '[SSN]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[EMAIL]')
    .slice(0, 200);
}

// TODO(RAI): bind to the sanctioned append-only RAI audit sink; this demo writes structured events to the app logger.
function rai(ctx, actionType, fields) {
  const event = {
    schema_version: '1.2', event_id: uuidv4(), timestamp: new Date().toISOString(), action_type: actionType,
    correlation_id: ctx.correlationId, session_id: ctx.sessionId, customer_ref: CUSTOMER_REF, channel: 'web', locale: ctx.locale,
    model: MODEL, prompt_template: PROMPT_TEMPLATE, service: SERVICE, service_version: '3.8.1', retention_class: 'rai_7y',
    ...fields,
  };
  logger.info('erica_rai_event', event);
  return event;
}

function classify(text) {
  const t = String(text || '').toLowerCase();
  const rules = [
    [/dispute|recogni[sz]e|fraud|unauthori[sz]ed|didn.?t make/, "I don't recognize a charge", 'unrecognized_charge'],
    [/unlock/, 'Unlock my card', 'unlock_card'],
    [/lock|freeze|lost|stolen/, 'Lock my card', 'lock_card'],
    [/balance|how much/, "What's my balance?", 'balance_inquiry'],
    [/transaction|activity|purchases/, 'Recent transactions', 'recent_transactions'],
    [/bill|due|upcoming/, 'Upcoming bills', 'upcoming_bills'],
    [/spend|budget/, 'How am I spending?', 'spending_insight'],
    [/specialist|agent|human|person|call/, 'Talk to a specialist', 'route_to_agent'],
  ];
  const hit = rules.find(([re]) => re.test(t));
  return hit ? { key: hit[1], intent: hit[2], confidence: 0.94 } : { key: 'help', intent: 'help', confidence: 0.41 };
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function reply(ctx, messages) {
  return { correlation_id: ctx.correlationId, messages };
}

function txnFromSelection(id) {
  const fx = fixtures.select[String(id)];
  if (!fx) return null;
  const txnCard = fx.messages[0].card || {};
  const chip = fixtures.text["I don't recognize a charge"].messages[0].chips
    .find((c) => c.action.type === 'select_dispute_transaction' && String(c.action.payload.transaction_id) === String(id));
  const network = /Mastercard/i.test(chip.detail) ? 'mastercard' : 'visa';
  const last4 = (chip.detail.match(/(\d{4})(?!.*\d{4})/) || [])[1];
  return { id: Number(id), network, last4, amount: txnCard.amount, merchant: txnCard.merchant, date: txnCard.date, label: chip.label };
}

function selectDispute(ctx, id) {
  const fx = fixtures.select[String(id)];
  const txn = txnFromSelection(id);
  rai(ctx, 'data_retrieval', { decision: { outcome: txn ? 'retrieved' : 'not_found', confidence: 1, rationale_codes: ['DATA_CARD_TRANSACTION'] }, customer_impact: 'informational' });
  if (!fx || !txn) {
    rai(ctx, 'guardrail_block', { decision: { outcome: 'blocked', confidence: 1, rationale_codes: ['OWNERSHIP_CHECK_FAILED'] }, guardrails: [{ name: 'ownership_check', version: '1.0', result: 'fail' }], customer_impact: 'financial_action' });
    return reply(ctx, [{ role: 'erica', text: "I couldn't find that transaction on your accounts. Choose a charge from your recent card activity and I'll help." }]);
  }
  const messages = clone(fx.messages);
  const confirm = messages.find((m) => m.card && m.card.type === 'lock_dispute_confirm');
  if (confirm) {
    const stageId = `stg_${uuidv4().replace(/-/g, '').slice(0, 20)}`;
    stages.set(stageId, { txn, sessionId: ctx.sessionId, createdAt: Date.now() });
    confirm.card.actions.forEach((a) => { a.action.payload.stage_id = stageId; });
    rai(ctx, 'transaction_staged', {
      decision: { outcome: 'staged', confidence: 1, rationale_codes: ['DISPUTE_UNRECOGNIZED_TRANSACTION', 'CARD_LOCK_RECOMMENDED', 'EXPLICIT_CONFIRMATION_REQUIRED'] },
      action_ref: { operation: 'lock_and_dispute', stage_id: stageId, resource: 'card', network: txn.network, transaction_id: String(txn.id) },
      disclosures_shown: ['DISPUTE_CERTIFICATION_V3'], customer_impact: 'financial_action', human_oversight: { required: true, performed: false, reviewer_role: 'customer' },
    });
  }
  return reply(ctx, messages);
}

function resolveNetworkReason(network, internalReason) {
  return NETWORK_REASON_CODES[network][internalReason];
}

function buildDisputeFiling(txn, correlationId) {
  const reason = resolveNetworkReason(txn.network, 'unrecognized_charge');
  return {
    transaction_id: txn.id,
    network: txn.network,
    network_reason_code: reason.code,
    network_reason_label: reason.label,
    amount: txn.amount,
    correlation_id: correlationId,
  };
}

function caseNumber() {
  return `CD-${new Date().getFullYear()}-${String(Math.floor(100000 + Math.random() * 899999))}`;
}

function confirmStaged(ctx, stageId, data) {
  const staged = stages.get(stageId);
  if (!staged) {
    rai(ctx, 'guardrail_block', { decision: { outcome: 'blocked', confidence: 1, rationale_codes: ['STAGE_NOT_FOUND_OR_EXPIRED'] }, guardrails: [{ name: 'explicit_confirmation', version: '1.0', result: 'fail' }], customer_impact: 'financial_action' });
    return reply(ctx, [{ role: 'erica', text: "That request expired or was already completed, so I didn't make any changes. Let's start again.", chips: [{ label: "I don't recognize a charge", action: { type: 'say', payload: { text: "I don't recognize a charge" } } }] }]);
  }
  stages.delete(stageId);
  const { txn } = staged;
  const startTime = Date.now();
  const submitted = rai(ctx, 'transaction_executed', {
    decision: { outcome: 'submitted', confidence: 1, rationale_codes: ['CUSTOMER_CONFIRMED', 'AUDIT_WRITE_AHEAD'] },
    guardrails: [{ name: 'explicit_confirmation', version: '1.0', result: 'pass' }, { name: 'audit_write_ahead', version: '1.0', result: 'pass' }],
    action_ref: { operation: 'dispute_file', resource: 'card', network: txn.network, transaction_id: String(txn.id) }, customer_impact: 'financial_action',
  });

  try {
    const filing = buildDisputeFiling(txn, ctx.correlationId);
    const number = caseNumber();
    rai(ctx, 'transaction_executed', {
      parent_event_id: submitted.event_id, latency_ms: Date.now() - startTime,
      decision: { outcome: 'succeeded', confidence: 1, rationale_codes: ['DOWNSTREAM_ACCEPTED'] },
      action_ref: { operation: 'dispute_file', resource: 'card', network: txn.network, transaction_id: String(txn.id), network_reason_code: filing.network_reason_code }, customer_impact: 'financial_action',
    });
    incrementMetric('erica_dispute.success', { route: ROUTE, network: txn.network });
    return reply(ctx, [{
      role: 'erica', tone: 'success',
      text: `Done. Your card ending in ${txn.last4} is locked and your dispute for ${txn.amount} from ${txn.merchant} is filed. Your case number is ${number}.`,
      card: {
        type: 'dispute_confirmation', title: 'Dispute filed', status: 'submitted',
        rows: [{ k: 'Case number', v: number }, { k: 'Card', v: `••••${txn.last4} · Locked` }, { k: 'Charge', v: `${txn.amount} · ${txn.merchant}` }, { k: 'Next step', v: "We'll send updates to your Online Banking Inbox." }],
      },
    }]);
  } catch (error) {
    const duration = Date.now() - startTime;
    const referenceId = ctx.correlationId;
    incrementMetric('erica_dispute.failure', { route: ROUTE, errorClass: error.name, network: txn.network });
    recordTiming('erica_dispute.latency', duration, { route: ROUTE, error: 'true' });
    rai(ctx, 'transaction_executed', {
      parent_event_id: submitted.event_id, latency_ms: duration,
      decision: { outcome: 'failed', confidence: 1, rationale_codes: ['EXECUTION_FAILED', 'FAILED_AT_DISPUTE_FILE'] },
      action_ref: { operation: 'dispute_file', resource: 'card', network: txn.network, transaction_id: String(txn.id) }, customer_impact: 'financial_action',
      error: { type: error.name, message: redact(error.message), stage: 'dispute_file' },
    });
    logger.error('Erica dispute filing failed', {
      referenceId, error: error.message, errorClass: error.name, durationMs: duration, network: txn.network, transactionId: txn.id, customerRef: CUSTOMER_REF,
    });
    const extra = { referenceId, network: txn.network, transactionId: txn.id, internalReason: 'unrecognized_charge', customerRef: CUSTOMER_REF };
    Sentry.captureException(error, { tags: { route: ROUTE, service: SERVICE, page: PAGE, card_network: txn.network, intent: 'confirm_staged_action' }, extra });
    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/e7fd3fee-erica.js — buildDisputeFiling',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Bank of America — Erica Card Dispute',
      customer: 'e7fd3fee',
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: [
        { key: 'route', value: ROUTE }, { key: 'service', value: SERVICE }, { key: 'card_network', value: txn.network }, { key: 'intent', value: 'confirm_staged_action' }, { key: 'page', value: PAGE },
      ],
      extra,
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: `ERICA-${referenceId.slice(0, 8).toUpperCase()}`,
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'erica-svc@3.8.1',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Erica dispute error', { error: err.message });
    });

    error.referenceId = referenceId;
    error.ericaMessages = [{
      role: 'erica', tone: 'error',
      text: `Something went wrong and I couldn't file your dispute for ${txn.amount} from ${txn.merchant}. Nothing has changed. Reference ${referenceId}.`,
      card: {
        type: 'error', title: 'Erica error: dispute not filed',
        rows: [{ k: `Card ••••${txn.last4}`, k_sr: `Card ending in ${txn.last4.split('').join(' ')}`, v: 'Not locked' }, { k: `Dispute for ${txn.amount}`, v: 'Not filed' }, { k: 'Erica', v: `${error.name}: ${error.message}` }],
        reference: referenceId,
        help: `Please call ${SUPPORT_LINE} right away. We're available 24/7.`,
      },
      chips: [{ label: 'Talk to a specialist', action: { type: 'say', payload: { text: 'Talk to a specialist' } } }],
    }];
    throw error;
  }
}

function chat(data) {
  const ctx = { correlationId: uuidv4(), sessionId: hash(data.sessionKey || 'anon'), locale: data.locale || 'en-US' };
  const action = data.action && typeof data.action === 'object' ? data.action : null;
  const payload = (action && action.payload) || {};
  let text = data.text;
  if (action && action.type === 'say') text = payload.text;

  if (action && action.type !== 'say') {
    rai(ctx, 'intent_classification', { input: { hash: hash(action.type) }, decision: { outcome: action.type, confidence: 1, rationale_codes: ['STRUCTURED_ACTION'] }, customer_impact: 'informational' });
    if (action.type === 'welcome') return reply(ctx, clone(fixtures.welcome.messages));
    if (action.type === 'select_dispute_transaction') return selectDispute(ctx, payload.transaction_id);
    if (action.type === 'confirm_staged') return confirmStaged(ctx, payload.stage_id, data);
    if (action.type === 'cancel_staged') {
      stages.delete(payload.stage_id);
      rai(ctx, 'transaction_executed', { decision: { outcome: 'canceled_by_customer', confidence: 1, rationale_codes: ['CUSTOMER_DECLINED_CONFIRMATION'] }, customer_impact: 'financial_action' });
      return reply(ctx, [{ role: 'erica', text: "Okay, I didn't make any changes. Your card and transactions are just as they were." }]);
    }
    text = action.type === 'select_unlock_card' ? 'Unlock my card' : action.type === 'select_lock_card' ? 'Lock my card' : 'help';
  }

  const cls = classify(text);
  rai(ctx, 'intent_classification', {
    input: { redacted_text: redact(text), hash: hash(text) },
    decision: { outcome: cls.intent, confidence: cls.confidence, rationale_codes: [cls.confidence > 0.8 ? 'INTENT_MATCH_HIGH_CONF' : 'INTENT_FALLBACK_HELP'] },
    customer_impact: 'informational',
  });
  const out = clone(fixtures.text[cls.key]);
  rai(ctx, 'response_generation', { output: { hash: hash(JSON.stringify(out.messages)) }, decision: { outcome: 'responded', confidence: cls.confidence, rationale_codes: ['TEMPLATE_RESPONSE'] }, customer_impact: 'informational' });
  return reply(ctx, out.messages);
}

module.exports = {
  chat, buildDisputeFiling, resolveNetworkReason, NETWORK_REASON_CODES, stages,
};
