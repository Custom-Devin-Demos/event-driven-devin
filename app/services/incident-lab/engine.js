const logger = require('../../telemetry/logger');
const { getScenario, listScenarios } = require('./scenario');
const { saveRunState, loadRunState, clearRunState } = require('./persistence');

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
 *   suspend()        → sinks.onSuspend timers cleared, run persisted (restart)
 *   resume()         → sinks.onResume  persisted run rebuilt after a restart
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

// Lifecycle mutations are serialized: sink hooks await external APIs
// (Datadog, Slack), and a stop() or arm() interleaving with an in-flight
// declare() could inspect the run before its incident exists — leaking a
// just-declared incident past cleanup or attaching resources to a
// replacement run. Every mutation waits for the previous one to settle.
let lifecycleChain = Promise.resolve();
function serialized(fn) {
  const next = lifecycleChain.then(fn, fn);
  lifecycleChain = next.then(() => {}, () => {});
  return next;
}

function snapshot() {
  if (!run) return null;
  return {
    runRef: run.runRef,
    scenarioId: run.scenario.id,
    status: run.status,
    armedAt: run.armedAt,
    declaredAt: run.declaredAt,
    incident: run.incident,
    phases: run.phases,
    phaseTimes: run.phaseTimes,
    log: run.log,
    telemetryService: run.telemetryService,
  };
}

function persist() {
  if (!run || run.status === 'stopped') {
    clearRunState();
  } else {
    saveRunState(snapshot());
  }
}

function makeRunRef() {
  return `LAB-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

function scheduleTimer(forRun, fn, delayMs) {
  const timer = setTimeout(fn, Math.max(delayMs, 0));
  if (timer.unref) timer.unref();
  forRun.timers.push(timer);
  return timer;
}

/**
 * Arm a scenario: baseline telemetry starts flowing and prelude events
 * (precursor bursts) are scheduled relative to now. No incident exists yet.
 */
function arm(scenarioId) {
  return serialized(() => armImpl(scenarioId));
}

async function armImpl(scenarioId) {
  if (run && run.status !== 'stopped') {
    return { ok: false, error: `A run is already ${run.status} (${run.runRef}). Stop it first.` };
  }
  const scenario = getScenario(scenarioId);
  if (!scenario) return { ok: false, error: `Unknown scenario: ${scenarioId}` };

  const runRef = makeRunRef();
  run = {
    runRef,
    scenario,
    status: 'armed',
    armedAt: Date.now(),
    declaredAt: null,
    incident: null,
    phases: [],
    phaseTimes: {},
    timers: [],
    log: [],
    // Per-run telemetry identity (cluster-style suffix from the run ref):
    // Datadog keeps prior runs' logs and metrics for its retention window,
    // and a rerun under the same service tag lets an investigator read a
    // previous run's telemetry as evidence for this one. Each run emits
    // under its own service so old runs read as a different cluster.
    telemetryService: `${scenario.service}-${runRef.split('-').pop().toLowerCase()}`,
  };
  const thisRun = run;
  note(`armed scenario ${scenario.id}`);
  persist();
  await fanOut('onArm', thisRun);
  return { ok: true, runRef: thisRun.runRef, status: thisRun.status };
}

/**
 * Declare the incident: T0 for the outage phases and the scripted persona
 * timeline. Sinks own the actual Datadog declaration/Slack posting; the
 * first sink to set run.incident ({ id, publicId }) wins.
 */
function declare() {
  return serialized(() => declareImpl());
}

async function declareImpl() {
  if (!run || run.status !== 'armed') {
    return { ok: false, error: run ? `Run is ${run.status}, expected armed` : 'No armed run' };
  }
  const thisRun = run;
  thisRun.status = 'declared';
  thisRun.declaredAt = Date.now();
  // First sink to set run.incident wins; later sinks cannot replace it.
  const errors = [];
  for (const sink of sinks) {
    if (typeof sink.onDeclare !== 'function') continue;
    const existing = thisRun.incident;
    try {
      await sink.onDeclare(thisRun);
    } catch (error) {
      errors.push(error);
      logger.warn('Incident Lab sink hook failed', {
        hook: 'onDeclare',
        sink: sink.name || 'anonymous',
        error: error.message,
      });
    }
    if (existing && thisRun.incident !== existing) thisRun.incident = existing;
  }
  // A slow sink may outlive a stop() (or stop + re-arm) issued meanwhile:
  // schedule nothing for a run that is no longer the active declared run.
  if (run !== thisRun || thisRun.status !== 'declared') {
    return { ok: false, error: 'Run was stopped during declaration' };
  }
  // The Datadog declaration is the core of declare(): without an incident
  // there is no Slack channel and no timeline. No incident — whether a
  // sink failed or no sink is configured to declare one — re-arms the run
  // (baseline noise keeps flowing) so the presenter can fix the setup and
  // retry; sink failures after an incident exists stay isolated as usual.
  if (!thisRun.incident) {
    const cause = errors.length ? errors[0].message : 'no sink declared an incident (Datadog incident keys missing?)';
    thisRun.status = 'armed';
    thisRun.declaredAt = null;
    note(`declaration failed — run re-armed (${cause})`);
    persist();
    return { ok: false, error: `Incident declaration failed: ${cause}`, runRef: thisRun.runRef, status: thisRun.status };
  }
  note('incident declared');
  persist();

  const phases = (thisRun.scenario.datadog && thisRun.scenario.datadog.phases) || [];
  for (const phase of phases) {
    if (phase.manual || !Number.isFinite(phase.startMs)) continue;
    // Negative startMs means the phase began before declaration (detection
    // gap): it activates immediately and sinks backfill its history.
    scheduleTimer(thisRun, () => serialized(() => activatePhase(phase.id)), phase.startMs);
  }
  scheduleTimer(thisRun, () => {
    if (run === thisRun && thisRun.status === 'declared') {
      note('scenario window elapsed');
    }
  }, thisRun.scenario.durationMs);
  return { ok: true, runRef: thisRun.runRef, status: thisRun.status, incident: thisRun.incident };
}

async function activatePhase(phaseId) {
  if (!run || run.status !== 'declared') return { ok: false, error: 'No declared run' };
  if (run.phases.includes(phaseId)) return { ok: false, error: `Phase ${phaseId} already active` };
  const phase = ((run.scenario.datadog && run.scenario.datadog.phases) || [])
    .find((p) => p.id === phaseId);
  if (!phase) return { ok: false, error: `Unknown phase: ${phaseId}` };
  run.phases.push(phaseId);
  run.phaseTimes[phaseId] = Date.now();
  note(`phase ${phaseId} active`);
  persist();
  await fanOut('onPhase', run, phase);
  return { ok: true, phase: phaseId };
}

/** Presenter override, restricted to phases marked "manual" (e.g.
 *  "mitigated") — timed phases belong to the scheduler alone. */
function triggerPhase(phaseId) {
  return serialized(() => {
    if (!run || run.status !== 'declared') return { ok: false, error: 'No declared run' };
    const phase = ((run.scenario.datadog && run.scenario.datadog.phases) || [])
      .find((p) => p.id === phaseId);
    if (!phase) return { ok: false, error: `Unknown phase: ${phaseId}` };
    if (!phase.manual) return { ok: false, error: `Phase ${phaseId} is not manually triggerable` };
    return activatePhase(phaseId);
  });
}

function stop(reason = 'stopped by presenter') {
  return serialized(() => stopImpl(reason));
}

async function stopImpl(reason) {
  if (!run) return { ok: false, error: 'No run' };
  if (run.status === 'stopped') return { ok: false, error: 'Run already stopped' };
  for (const timer of run.timers) clearTimeout(timer);
  run.timers = [];
  const prior = run.status;
  run.status = 'stopped';
  note(`stopped (${reason})`);
  persist();
  await fanOut('onStop', run, reason);
  return { ok: true, priorStatus: prior };
}

/**
 * Suspend for a restart: persist the run and tear down timers without
 * resolving the Datadog incident or ending the run — resume() rebuilds it
 * when the new process starts.
 */
function suspend(reason = 'process restarting') {
  return serialized(() => suspendImpl(reason));
}

async function suspendImpl(reason) {
  if (!run || run.status === 'stopped') return { ok: false, error: 'No active run' };
  for (const timer of run.timers) clearTimeout(timer);
  run.timers = [];
  note(`suspended (${reason})`);
  persist();
  await fanOut('onSuspend', run, reason);
  return { ok: true, status: run.status };
}

/**
 * Resume a persisted run after a restart: rebuild the run in memory,
 * reschedule pending automatic phases against the original clock, and let
 * sinks reattach (baseline telemetry, persona script) via onResume.
 */
function resume() {
  return serialized(() => resumeImpl());
}

async function resumeImpl() {
  if (run && run.status !== 'stopped') return { ok: false, error: 'A run is already active' };
  const saved = loadRunState();
  if (!saved || (saved.status !== 'armed' && saved.status !== 'declared')) {
    return { ok: false, error: 'No resumable run' };
  }
  const scenario = getScenario(saved.scenarioId);
  if (!scenario) {
    clearRunState();
    return { ok: false, error: `Persisted run references unknown scenario: ${saved.scenarioId}` };
  }
  run = {
    runRef: saved.runRef,
    scenario,
    status: saved.status,
    armedAt: saved.armedAt,
    declaredAt: saved.declaredAt,
    incident: saved.incident,
    phases: saved.phases || [],
    phaseTimes: saved.phaseTimes || {},
    timers: [],
    log: saved.log || [],
    // Runs persisted before per-run identity existed fall back to the
    // scenario's base service, matching what they already emitted under.
    telemetryService: saved.telemetryService || scenario.service,
  };
  const thisRun = run;
  note('resumed after restart');
  if (thisRun.status === 'declared') {
    const phases = (thisRun.scenario.datadog && thisRun.scenario.datadog.phases) || [];
    for (const phase of phases) {
      if (phase.manual || !Number.isFinite(phase.startMs)) continue;
      if (thisRun.phases.includes(phase.id)) continue;
      const delayMs = thisRun.declaredAt + phase.startMs - Date.now();
      scheduleTimer(thisRun, () => serialized(() => activatePhase(phase.id)), delayMs);
    }
    scheduleTimer(thisRun, () => {
      if (run === thisRun && thisRun.status === 'declared') {
        note('scenario window elapsed');
      }
    }, thisRun.declaredAt + thisRun.scenario.durationMs - Date.now());
  }
  persist();
  await fanOut('onResume', thisRun);
  return { ok: true, runRef: thisRun.runRef, status: thisRun.status };
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
    telemetryService: run.telemetryService,
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
  lifecycleChain = Promise.resolve();
  clearRunState();
}

module.exports = {
  registerSink,
  arm,
  declare,
  triggerPhase,
  activatePhase: triggerPhase,
  stop,
  suspend,
  resume,
  status,
  currentRun,
  resetForTests,
};
