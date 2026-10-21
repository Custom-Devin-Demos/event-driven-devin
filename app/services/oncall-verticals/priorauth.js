const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const ROUTE = '/api/oncall/payer/prior-auth';
const SERVICE = 'payer-priorauth-api';
const RUNTIME_SNAPSHOT_TTL_MS = 60 * 1000;
const RUNTIME_RECORDS_PER_SUBMISSION = 40;

const MEMBERS = [
  { memberId: 'LSHP-100245-01', plan: 'Larkspur Choice PPO', group: 'GRP-40118', coverage: 'active' },
  { memberId: 'LSHP-100245-02', plan: 'Larkspur Choice PPO', group: 'GRP-40118', coverage: 'active' },
  { memberId: 'LSHP-208871-01', plan: 'Larkspur Medicare Advantage', group: 'GRP-77302', coverage: 'active' },
  { memberId: 'LSHP-311902-01', plan: 'Larkspur Select HMO', group: 'GRP-51920', coverage: 'inactive' },
];

const PROCEDURES = {
  '70553': { cptCode: '70553', label: 'MRI brain without and with contrast', requiresAuth: true, policyId: 'RAD-MRI-2025' },
  '27447': { cptCode: '27447', label: 'Total knee arthroplasty', requiresAuth: true, policyId: 'ORTHO-JOINT-2025' },
  '97110': { cptCode: '97110', label: 'Therapeutic exercises', requiresAuth: true, policyId: 'REHAB-PT-2025' },
  '95810': { cptCode: '95810', label: 'Polysomnography sleep study', requiresAuth: true, policyId: 'SLEEP-STUDY-2025' },
  '99213': { cptCode: '99213', label: 'Established patient office visit', requiresAuth: false, policyId: null },
};

const priorAuthCache = new Map();
const runtimeKeys = new Set();
const syntheticKeys = new Set();

function expireRuntimeRecords() {
  const cutoff = Date.now() - RUNTIME_SNAPSHOT_TTL_MS;
  let expired = 0;
  for (const key of runtimeKeys) {
    const record = priorAuthCache.get(key);
    if (!record || record.createdAt < cutoff) {
      if (priorAuthCache.delete(key)) expired++;
      runtimeKeys.delete(key);
      syntheticKeys.delete(key);
    }
  }
  if (expired > 0) {
    logger.info('Settled prior-authorization records dropped from cache', {
      expired,
      entries: priorAuthCache.size,
      service: SERVICE,
    });
  }
}

function hydrateFromJournal() {
  const memberIds = MEMBERS.filter((member) => member.coverage === 'active').map((member) => member.memberId);
  const procedures = Object.values(PROCEDURES).filter((procedure) => procedure.requiresAuth);
  for (let i = 0; i < 120; i++) {
    const procedure = procedures[i % procedures.length];
    priorAuthCache.set(`journal-${String(i).padStart(4, '0')}`, {
      requestKey: `journal-${i}`,
      authId: `PA-JOURNAL${String(i).padStart(4, '0')}`,
      memberId: memberIds[i % memberIds.length],
      cptCode: procedure.cptCode,
      policyId: procedure.policyId,
    });
  }
  logger.info('Prior-authorization journal loaded', {
    entries: priorAuthCache.size,
    service: SERVICE,
  });
}

hydrateFromJournal();

async function verifyPolicyRecord(record) {
  await new Promise((resolve) => setTimeout(resolve, 22 + Math.random() * 8));
  return Object.values(PROCEDURES).some((procedure) => procedure.policyId === record.policyId);
}

async function findDuplicateRequest(requestKey) {
  let duplicate = null;
  for (const record of priorAuthCache.values()) {
    const valid = await verifyPolicyRecord(record);
    if (valid && record.requestKey === requestKey) duplicate = record;
  }
  return duplicate;
}

function createRequestKey(data) {
  return [
    data.memberId,
    data.providerNpi,
    data.cptCode,
    data.icd10,
    data.serviceDate,
    data.urgency,
    data.clinicalNotes,
  ].join('|');
}

function addRuntimeRecords({ requestKey, authId, memberId, cptCode, policyId }, options) {
  for (let page = 1; page <= RUNTIME_RECORDS_PER_SUBMISSION; page++) {
    const key = `runtime-${uuidv4()}`;
    priorAuthCache.set(key, {
      requestKey,
      authId,
      memberId,
      cptCode,
      policyId,
      documentPage: page,
      createdAt: Date.now(),
    });
    runtimeKeys.add(key);
    if (options.synthetic) syntheticKeys.add(key);
  }
}

async function submitPriorAuth({
  memberId,
  providerNpi,
  cptCode,
  icd10,
  serviceDate,
  urgency,
  clinicalNotes = '',
} = {}, options = {}) {
  const startTime = Date.now();
  const authId = `PA-${uuidv4().replace(/-/g, '').slice(0, 8).toUpperCase()}`;

  logger.info('Submitting prior authorization', {
    authId,
    memberId,
    providerNpi,
    cptCode,
    icd10,
    urgency,
    cacheEntries: priorAuthCache.size,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    expireRuntimeRecords();
    const member = MEMBERS.find((candidate) => candidate.memberId === memberId);
    if (!member || member.coverage !== 'active') {
      const error = new Error(`Member is not eligible: ${memberId}`);
      error.code = 'MEMBER_NOT_ELIGIBLE';
      throw error;
    }

    const procedure = PROCEDURES[String(cptCode || '')];
    if (!procedure) {
      const error = new Error(`Procedure is not covered: ${cptCode}`);
      error.code = 'PROCEDURE_NOT_FOUND';
      throw error;
    }

    if (!procedure.requiresAuth) {
      const durationMs = Date.now() - startTime;
      incrementMetric('priorauth.success', { route: ROUTE, cptCode: procedure.cptCode });
      recordTiming('priorauth.latency', durationMs, { route: ROUTE });
      return {
        success: true,
        status: 'NOT_REQUIRED',
        memberId,
        cptCode: procedure.cptCode,
        durationMs,
      };
    }

    const normalizedRequest = {
      memberId,
      providerNpi,
      cptCode: procedure.cptCode,
      icd10,
      serviceDate,
      urgency: urgency === 'urgent' ? 'urgent' : 'standard',
      clinicalNotes: String(clinicalNotes || '').slice(0, 2000),
    };
    const requestKey = createRequestKey(normalizedRequest);
    const duplicate = await findDuplicateRequest(requestKey);
    const resolvedAuthId = duplicate ? duplicate.authId : authId;
    addRuntimeRecords({
      requestKey,
      authId: resolvedAuthId,
      memberId,
      cptCode: procedure.cptCode,
      policyId: procedure.policyId,
    }, options);

    const durationMs = Date.now() - startTime;
    const status = normalizedRequest.urgency === 'urgent' ? 'APPROVED' : 'PENDED_FOR_CLINICAL_REVIEW';
    const decisionDueBy = new Date(Date.now() + (status === 'APPROVED' ? 60 : 24 * 60) * 60 * 1000).toISOString();

    incrementMetric('priorauth.success', { route: ROUTE, cptCode: procedure.cptCode });
    recordTiming('priorauth.latency', durationMs, { route: ROUTE });
    logger.info('Prior authorization submitted', {
      authId: resolvedAuthId,
      status,
      durationMs,
      cacheEntries: priorAuthCache.size,
      memberId,
      cptCode: procedure.cptCode,
      service: SERVICE,
    });

    return {
      success: true,
      authId: resolvedAuthId,
      status,
      decisionDueBy,
      memberId,
      cptCode: procedure.cptCode,
      durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    incrementMetric('priorauth.error', { route: ROUTE, errorClass: error.name });
    recordTiming('priorauth.latency', durationMs, { route: ROUTE, error: 'true' });
    logger.error('Prior-authorization submission failed', {
      authId,
      error: error.message,
      errorClass: error.name,
      code: error.code,
      durationMs,
      memberId,
      cptCode,
      cacheEntries: priorAuthCache.size,
      service: SERVICE,
    });
    Sentry.captureException(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        ...(options.synthetic ? { synthetic_probe: 'true' } : {}),
      },
      extra: { authId, memberId, providerNpi, cptCode, icd10 },
    });
    throw error;
  }
}

function releaseAccumulatedPriorAuthRecords() {
  let released = 0;
  for (const key of syntheticKeys) {
    if (priorAuthCache.delete(key)) released++;
    runtimeKeys.delete(key);
  }
  syntheticKeys.clear();
  if (released > 0) {
    logger.info('Synthetic-probe prior-authorization records released', {
      released,
      entries: priorAuthCache.size,
      service: SERVICE,
    });
  }
  return released;
}

module.exports = {
  submitPriorAuth,
  MEMBERS,
  PROCEDURES,
  releaseAccumulatedPriorAuthRecords,
};
