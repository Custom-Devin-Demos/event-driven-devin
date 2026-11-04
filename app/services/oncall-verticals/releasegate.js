const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const ROUTE = '/api/oncall/releasegate/evaluate';

/**
 * Release candidates per program as loaded from the bench results store.
 * `gatePolicy` selects the scoring thresholds from GATE_POLICIES.
 */
const PROGRAMS = new Map([
  ['INV800', {
    name: '800 V SiC traction inverter', swVersion: 'INV-SW 3.5.0-rc1', gatePolicy: 'ASIL-D-800V',
    executed: 412, passed: 401, hilCoverage: 0.94, openS1: 0, openS2: 1,
  }],
  ['IDM220', {
    name: 'Integrated drive module 220 kW', swVersion: 'IDM-SW 2.8.2', gatePolicy: 'ASIL-C',
    executed: 318, passed: 312, hilCoverage: 0.97, openS1: 0, openS2: 0,
  }],
  ['DCDC48', {
    name: '48 V DC/DC converter', swVersion: 'DCDC-SW 1.14.0', gatePolicy: 'ASIL-B',
    executed: 186, passed: 179, hilCoverage: 0.91, openS1: 0, openS2: 2,
  }],
  ['OBC11', {
    name: '11 kW on-board charger', swVersion: 'OBC-SW 4.2.1', gatePolicy: 'ASIL-B',
    executed: 204, passed: 203, hilCoverage: 0.99, openS1: 0, openS2: 0,
  }],
]);

const GATE_POLICIES = {
  'ASIL-C': { minPassRate: 0.97, minHilCoverage: 0.95, maxOpenS2: 1 },
  'ASIL-B': { minPassRate: 0.95, minHilCoverage: 0.90, maxOpenS2: 3 },
  QM: { minPassRate: 0.90, minHilCoverage: 0.75, maxOpenS2: 5 },
};

function round(value, places) {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

/**
 * Score a program's current release candidate against its gate policy.
 */
async function evaluateReleaseGate(request, options = {}) {
  const startTime = Date.now();
  const evaluationId = uuidv4();
  const program = String(request.program || '').toUpperCase();

  logger.info('Release gate evaluation', {
    evaluationId, program, service: 'release-gate-api', route: ROUTE,
  });

  try {
    const candidate = PROGRAMS.get(program);
    if (!candidate) {
      const error = new Error(`Unknown program: ${program}`);
      error.code = 'PROGRAM_NOT_FOUND';
      throw error;
    }
    const policy = GATE_POLICIES[candidate.gatePolicy];
    const passRate = candidate.passed / candidate.executed;
    const blockers = [];
    if (passRate < policy.minPassRate) blockers.push(`Pass rate ${round(passRate * 100, 1)}% below ${policy.minPassRate * 100}%`);
    if (candidate.hilCoverage < policy.minHilCoverage) blockers.push(`HIL coverage ${round(candidate.hilCoverage * 100, 1)}% below ${policy.minHilCoverage * 100}%`);
    if (candidate.openS1 > 0) blockers.push(`${candidate.openS1} open S1 defect(s)`);
    const amber = candidate.openS2 > policy.maxOpenS2;
    const status = blockers.length ? 'RED' : (amber ? 'AMBER' : 'GREEN');
    const duration = Date.now() - startTime;

    incrementMetric('releasegate.evaluate.success', { route: ROUTE });
    recordTiming('releasegate.evaluate.latency', duration, { route: ROUTE });

    return {
      success: true,
      evaluationId,
      program,
      name: candidate.name,
      swVersion: candidate.swVersion,
      status,
      passRate: round(passRate, 4),
      hilCoverage: candidate.hilCoverage,
      executed: candidate.executed,
      passed: candidate.passed,
      openS2: candidate.openS2,
      blockers,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('releasegate.evaluate.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('releasegate.evaluate.latency', duration, { route: ROUTE, error: 'true' });
    logger.error('Release gate evaluation failed', {
      evaluationId, error: error.message, errorClass: error.name, code: error.code, durationMs: duration, program,
    });
    if (error.code !== 'PROGRAM_NOT_FOUND') {
      Sentry.captureException(error, {
        tags: { route: ROUTE, service: 'release-gate-api', ...(options.synthetic ? { synthetic_probe: 'true' } : {}) },
        extra: { evaluationId, program },
      });
    }
    throw error;
  }
}

module.exports = { evaluateReleaseGate, PROGRAMS };
