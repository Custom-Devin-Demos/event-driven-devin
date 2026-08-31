const logger = require('../../telemetry/logger');
const { getScenario, listScenarios } = require('./scenario');

/**
 * Incident Lab run engine: the lifecycle and clock for one evolving
 * incident. The engine itself has no side effects — sinks (the Datadog
 * emitter, the Slack persona layer) register against it and receive
 * lifecycle callbacks:
 *
 *   arm(scenarioId)  → sinks.onArm    baseline noise starts, prelude events schedule
 *   declare()        → sinks.onDeclare outage phases + scripted timeline start
 *   phase changes    → sinks.onPhase  (automatic by startMs, or manual via triggerPhase)
 *   stop()/reset()   → sinks.onStop   all timers cleared
 *
 * Only one run is active at a time — the lab is a single-presenter surface.
 */

const sinks = [];

function registerSink(sink) {
  sinks.push(sink);
}

async function fanOut(hook, ...args) {
  const errors = [];
  for (const sink of sinks) {
    if (typeof sink[hook] !== 'function') continue;
    try {
      await sink[hook](...args);
    } catch (error) {
      errors.push(error);
      logger.warn('Incident Lab sink hook failed', {
        hook,
        sink: sink.name || 'anonymous',
        error: error.message,
      });
    }
  }
  return errors;
}

let run = null;

function makeRunRef() {
  return `LAB-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

function scheduleTimer(fn, delayMs) {
  const timer = setTimeout(fn, Math.max(delayMs, 0));
  if (timer.unref) timer.unref();
  run.timers.push(timer);
  return timer;
}

/**
 * Arm a scenario: baseline telemetry starts flowing and prelude events
 * (precursor bursts) are scheduled relative to now. No incident exists yet.
 */
async function arm(scenarioId) {
  if (run && run.status !== 'stopped') {
    return { ok: false, error: `A run is already ${run.status} (${run.runRef}). Stop it first.` };
  }
  const scenario = getScenario(scenarioId);
  if (!scenario) return { ok: false, error: `Unknown scenario: ${scenarioId}` };

  run = {
    runRef: makeRunRef(),
    scenario,
    status: 'armed',
    armedAt: Date.now(),
    declaredAt: null,
    incident: null,
    phases: [],
    timers: [],
    log: [],
  };
  note(`armed scenario ${scenario.id}`);
  await fanOut('onArm', run);
  return { ok: true, runRef: run.runRef, status: run.status };
}

/**
 * Declare the incident: T0 for the outage phases and the scripted persona
 * timeline. Sinks own the actual Datadog declaration/Slack posting; the
 * first sink to set run.incident ({ id, publicId }) wins.
 */
async function declare() {
  if (!run || run.status !== 'armed') {
    return { ok: false, error: run ? `Run is ${run.status}, expected armed` : 'No armed run' };
  }
  run.status = 'declared';
  run.declaredAt = Date.now();
  note('incident declared');
  const errors = await fanOut('onDeclare', run);
  // The Datadog declaration is the core of declare(): without an incident
  // there is no Slack channel and no timeline. A sink failure with no
  // incident re-arms the run (baseline noise keeps flowing) so the
  // presenter can retry; sink failures after an incident exists stay
  // isolated as usual.
  if (errors.length && !run.incident) {
    run.status = 'armed';
    run.declaredAt = null;
    note(`declaration failed — run re-armed (${errors[0].message})`);
    return { ok: false, error: `Incident declaration failed: ${errors[0].message}`, runRef: run.runRef, status: run.status };
  }

  const phases = (run.scenario.datadog && run.scenario.datadog.phases) || [];
  for (const phase of phases) {
    if (phase.manual || !Number.isFinite(phase.startMs)) continue;
    // Negative startMs means the phase began before declaration (detection
    // gap): it activates immediately and sinks backfill its history.
    scheduleTimer(() => activatePhase(phase.id), phase.startMs);
  }
  scheduleTimer(() => {
    if (run && run.status === 'declared') {
      note('scenario window elapsed');
    }
  }, run.scenario.durationMs);
  return { ok: true, runRef: run.runRef, status: run.status, incident: run.incident };
}

async function activatePhase(phaseId) {
  if (!run || run.status !== 'declared') return { ok: false, error: 'No declared run' };
  if (run.phases.includes(phaseId)) return { ok: false, error: `Phase ${phaseId} already active` };
  const phase = ((run.scenario.datadog && run.scenario.datadog.phases) || [])
    .find((p) => p.id === phaseId);
  if (!phase) return { ok: false, error: `Unknown phase: ${phaseId}` };
  run.phases.push(phaseId);
  note(`phase ${phaseId} active`);
  await fanOut('onPhase', run, phase);
  return { ok: true, phase: phaseId };
}

/** Presenter override for manual phases (e.g. "mitigated"). */
async function triggerPhase(phaseId) {
  return activatePhase(phaseId);
}

async function stop(reason = 'stopped by presenter') {
  if (!run) return { ok: false, error: 'No run' };
  for (const timer of run.timers) clearTimeout(timer);
  run.timers = [];
  const prior = run.status;
  run.status = 'stopped';
  note(`stopped (${reason})`);
  await fanOut('onStop', run, reason);
  return { ok: true, priorStatus: prior };
}

function note(message) {
  if (!run) return;
  run.log.push({ at: new Date().toISOString(), message });
  logger.info('Incident Lab', { runRef: run.runRef, message });
}

function status() {
  if (!run) return { status: 'idle', scenarios: listScenarios() };
  return {
    status: run.status,
    runRef: run.runRef,
    scenario: run.scenario.id,
    armedAt: run.armedAt ? new Date(run.armedAt).toISOString() : null,
    declaredAt: run.declaredAt ? new Date(run.declaredAt).toISOString() : null,
    elapsedMs: run.declaredAt ? Date.now() - run.declaredAt : null,
    incident: run.incident,
    phases: run.phases,
    log: run.log.slice(-30),
    scenarios: listScenarios(),
  };
}

function currentRun() {
  return run;
}

/** Test-only: drop all state. */
function resetForTests() {
  if (run) for (const timer of run.timers) clearTimeout(timer);
  run = null;
  sinks.length = 0;
}

module.exports = {
  registerSink,
  arm,
  declare,
  triggerPhase,
  activatePhase,
  stop,
  status,
  currentRun,
  resetForTests,
};
