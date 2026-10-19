const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const ROUTE = '/api/oncall/pbm/claim';
const SERVICE = 'pbm-claims-api';

const MEMBERS = [
  { memberId: 'FRX-100245-01', plan: 'Commercial PPO', group: 'GRP-40118', status: 'active' },
  { memberId: 'FRX-100245-02', plan: 'Commercial PPO', group: 'GRP-40118', status: 'active' },
  { memberId: 'FRX-208871-01', plan: 'Medicare Part D', group: 'GRP-77302', status: 'active' },
  { memberId: 'FRX-311902-01', plan: 'Commercial HMO', group: 'GRP-51920', status: 'terminated' },
];

const FORMULARY = [
  { ndc: '00093505898', label: 'Atorvastatin 20 mg tablet', tier: 1, unitCostCents: 12 },
  { ndc: '68180051301', label: 'Lisinopril 10 mg tablet', tier: 1, unitCostCents: 6 },
  { ndc: '65862000801', label: 'Metformin ER 500 mg tablet', tier: 1, unitCostCents: 10 },
  { ndc: '00378180110', label: 'Levothyroxine 50 mcg tablet', tier: 2, unitCostCents: 18 },
  { ndc: '00781527892', label: 'Escitalopram 10 mg tablet', tier: 2, unitCostCents: 14 },
  { ndc: '61314064705', label: 'Adalimumab-adaz 40 mg/0.4 mL pen', tier: 4, unitCostCents: 145000 },
];

const VENDORS = [
  { id: 'um-prior-auth', kind: 'prior-authorization' },
  { id: 'um-step-therapy', kind: 'step-therapy' },
  { id: 'um-quantity-limits', kind: 'quantity-limit' },
  { id: 'um-dur-safety', kind: 'drug-utilization-review' },
  { id: 'um-specialty-mgmt', kind: 'specialty' },
  { id: 'acc-deductible', kind: 'deductible-accumulator' },
  { id: 'acc-oop-max', kind: 'oop-accumulator' },
  { id: 'acc-copay-assist', kind: 'copay-accumulator' },
];

const ADJUDICATION_DEADLINE_MS = 8000;
const UM_CALL_LATENCY_MS = [1000, 1250];
const DISPENSING_FEE_CENTS = 175;
const TIER_COPAY_CENTS = { 1: 500, 2: 1500, 3: 4500 };
const SPECIALTY_COINSURANCE = 0.25;
const SPECIALTY_COPAY_CAP_CENTS = 25000;

function probeVendor(vendor) {
  const [minMs, maxMs] = UM_CALL_LATENCY_MS;
  return new Promise((resolve) => {
    setTimeout(() => resolve({ vendor: vendor.id, edits: [] }), minMs + Math.random() * (maxMs - minMs));
  });
}

function withDeadline(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} exceeded ${ms}ms`);
      err.code = 'ADJUDICATION_TIMEOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function evaluateUmEdits(member, drug, quantity, claimId) {
  for (const vendor of VENDORS) {
    const startedAt = Date.now();
    const result = await probeVendor(vendor);
    logger.info('UM edit probe', {
      claimId,
      ndc: drug.ndc,
      vendor: vendor.id,
      kind: vendor.kind,
      edits: result.edits,
      durationMs: Date.now() - startedAt,
      service: SERVICE,
      endpoint: 'um/v1/evaluate',
    });
  }
  return { umRef: `UM-${claimId.slice(0, 8).toUpperCase()}` };
}

function lookupDrug(ndc) {
  const normalizedNdc = String(ndc || '').replace(/-/g, '');
  return FORMULARY.find((drug) => drug.ndc === normalizedNdc) || null;
}

async function submitClaim({
  memberId, ndc, pharmacyId, quantity: requestedQuantity, daysSupply: requestedDaysSupply, rxNumber, prescriberNpi,
}, options = {}) {
  const startTime = Date.now();
  const claimId = uuidv4();

  logger.info('Submitting pharmacy claim', {
    claimId,
    memberId,
    ndc,
    pharmacyId,
    quantity: requestedQuantity,
    daysSupply: requestedDaysSupply,
    rxNumber,
    prescriberNpi,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    const member = MEMBERS.find((candidate) => candidate.memberId === memberId);
    if (!member || member.status !== 'active') {
      const err = new Error(`Member is not eligible: ${memberId}`);
      err.code = 'MEMBER_NOT_ELIGIBLE';
      throw err;
    }

    const drug = lookupDrug(ndc);
    if (!drug) {
      const err = new Error(`NDC is not covered: ${ndc}`);
      err.code = 'NDC_NOT_COVERED';
      throw err;
    }

    const quantity = Math.min(Math.max(parseInt(requestedQuantity, 10) || 30, 1), 360);
    const daysSupply = Math.min(Math.max(parseInt(requestedDaysSupply, 10) || 30, 1), 90);
    const adjudication = await withDeadline(
      evaluateUmEdits(member, drug, quantity, claimId),
      ADJUDICATION_DEADLINE_MS,
      'UM evaluation',
    );

    const duration = Date.now() - startTime;
    const ingredientCostCents = drug.unitCostCents * quantity;
    const memberCopayCents = drug.tier === 4
      ? Math.min(Math.round(ingredientCostCents * SPECIALTY_COINSURANCE), SPECIALTY_COPAY_CAP_CENTS)
      : TIER_COPAY_CENTS[drug.tier];
    const planPaysCents = Math.max(ingredientCostCents + DISPENSING_FEE_CENTS - memberCopayCents, 0);

    incrementMetric('pbm_claim.submit.success', { route: ROUTE, ndc: drug.ndc });
    recordTiming('pbm_claim.submit.latency', duration, { route: ROUTE });

    return {
      success: true,
      claimId: `CLM-${claimId.slice(0, 8).toUpperCase()}`,
      status: 'PAID',
      memberId,
      ndc: drug.ndc,
      label: drug.label,
      quantity,
      daysSupply,
      tier: drug.tier,
      ingredientCost: ingredientCostCents / 100,
      dispensingFee: DISPENSING_FEE_CENTS / 100,
      memberCopay: memberCopayCents / 100,
      planPays: planPaysCents / 100,
      umRef: adjudication.umRef,
      adjudicatedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('pbm_claim.submit.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('pbm_claim.submit.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Pharmacy claim adjudication failed', {
      claimId,
      error: error.message,
      errorClass: error.name,
      code: error.code,
      durationMs: duration,
      memberId,
      ndc,
      pharmacyId,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        ...(options.synthetic ? { synthetic_probe: 'true' } : {}),
      },
      extra: { claimId, memberId, ndc, quantity: requestedQuantity, pharmacyId },
    });

    throw error;
  }
}

module.exports = { submitClaim, MEMBERS, FORMULARY, VENDORS };
