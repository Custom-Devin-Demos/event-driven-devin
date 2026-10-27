const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const ROUTE = '/api/oncall/coveragecheck/coverage';
const SERVICE = 'eligibility-api';

/**
 * Insurers offered in the signup coverage check, keyed by the insurer id the
 * signup form sends. `payerId` is the clearinghouse payer the eligibility
 * check is routed to.
 */
const INSURERS = {
  aetna: { name: 'Aetna', payerId: 'AETNA' },
  ambetter: { name: 'Ambetter', payerId: 'CENTENE-AMB' },
  'bsw-health-plan': { name: 'Baylor Scott & White Health Plan', payerId: 'BSWHP' },
  'bcbs-tx': { name: 'Blue Cross Blue Shield of Texas', payerId: 'BCBSTX-HCSC' },
  'christus-health-plan': { name: 'CHRISTUS Health Plan', payerId: 'CHRISTUS' },
  cigna: { name: 'Cigna', payerId: 'CIGNA' },
  'community-first': { name: 'Community First Health Plans', payerId: 'CFHP' },
  'community-health-choice': { name: 'Community Health Choice', payerId: 'CHCTX' },
  'cook-childrens': { name: "Cook Children's Health Plan", payerId: 'CCHP' },
  molina: { name: 'Molina Healthcare', payerId: 'MOLINA' },
  oscar: { name: 'Oscar Health', payerId: 'OSCAR' },
  sendero: { name: 'Sendero Health Plans', payerId: 'SENDERO' },
  'texas-childrens': { name: "Texas Children's Health Plan", payerId: 'TCHP' },
  unitedhealthcare: { name: 'UnitedHealthcare', payerId: 'UHC' },
  wellcare: { name: 'WellCare', payerId: 'WELLCARE' },
};

/**
 * Network contracts by payer: whether Pomelo visits are in-network and the
 * typical member copay for a standard visit.
 */
const NETWORK_CONTRACTS = {
  AETNA: { inNetwork: true, copayCents: 2500, referralPlans: ['HMO'] },
  'CENTENE-AMB': { inNetwork: true, copayCents: 2000, referralPlans: ['HMO'] },
  BSWHP: { inNetwork: false },
  BCBSTX: { inNetwork: true, copayCents: 2500, referralPlans: ['HMO'] },
  CHRISTUS: { inNetwork: false },
  CIGNA: { inNetwork: true, copayCents: 3000, referralPlans: [] },
  CFHP: { inNetwork: false },
  CHCTX: { inNetwork: false },
  CCHP: { inNetwork: false },
  MOLINA: { inNetwork: false },
  OSCAR: { inNetwork: true, copayCents: 2500, referralPlans: [] },
  SENDERO: { inNetwork: false },
  TCHP: { inNetwork: false },
  UHC: { inNetwork: true, copayCents: 2500, referralPlans: ['HMO'] },
  WELLCARE: { inNetwork: false },
};

function invalidRequest(message) {
  const err = new Error(message);
  err.code = 'INVALID_COVERAGE_REQUEST';
  return err;
}

/**
 * Check whether Pomelo is in-network with the member's insurer and estimate
 * the cost of a standard visit.
 */
async function checkCoverage(request) {
  const startTime = Date.now();
  const checkId = uuidv4();
  const insurerId = String(request.insurer || '');
  const state = String(request.state || '').toUpperCase();

  logger.info('Coverage check started', { checkId, insurer: insurerId, state, service: SERVICE, route: ROUTE });

  try {
    if (!/^[A-Z]{2}$/.test(state)) throw invalidRequest(`Unknown state: ${state}`);
    const insurer = Object.hasOwn(INSURERS, insurerId) ? INSURERS[insurerId] : null;
    if (!insurer) throw invalidRequest(`Unknown insurer: ${insurerId}`);

    const contract = NETWORK_CONTRACTS[insurer.payerId];
    const covered = contract.inNetwork === true;
    const duration = Date.now() - startTime;

    incrementMetric('coverage.check.success', { route: ROUTE, covered: String(covered) });
    recordTiming('coverage.check.latency', duration, { route: ROUTE });

    return {
      success: true,
      checkId,
      state,
      insurer: { id: insurerId, name: insurer.name },
      covered,
      estimatedCostCents: covered ? contract.copayCents : null,
      referralPlans: covered ? contract.referralPlans : [],
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('coverage.check.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('coverage.check.latency', duration, { route: ROUTE, error: 'true' });
    logger.error('Coverage check failed', {
      checkId, error: error.message, errorClass: error.name, code: error.code, durationMs: duration, insurer: insurerId, state, service: SERVICE,
    });
    if (!error.code) {
      Sentry.captureException(error, {
        tags: { route: ROUTE, service: SERVICE },
        extra: { checkId, insurer: insurerId, state },
      });
    }
    throw error;
  }
}

module.exports = { checkCoverage, INSURERS, NETWORK_CONTRACTS };
