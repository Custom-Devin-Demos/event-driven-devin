const axios = require('axios');
const logger = require('../../telemetry/logger');
const { declareDatadogIncident, resolveDatadogIncident } = require('../datadog-incidents');

/**
 * Incident Lab Datadog sink: turns a scenario's telemetry spec into real
 * metrics and logs in Datadog, so the investigation surface (dashboards,
 * log search) is genuine — messy baseline noise, prelude bursts, outage
 * phases with backfilled history, and recovery.
 *
 * Everything is namespaced: metrics under `<metricPrefix>.*`, logs and
 * metrics tagged `service:<scenario.service>`, so nothing overlaps the
 * existing demo services' dashboards or monitors.
 *
 * Uses only DD_API_KEY (metric series v2 + logs intake v2); the incident
 * declaration additionally needs DD_INCIDENT_APP_KEY / DD_APPLICATION_KEY.
 */

const FLUSH_INTERVAL_MS = 10000;
// Metrics intake accepts points up to ~1h old, logs up to ~18h — cap the
// backfill window so late points are not silently dropped by Datadog.
const METRIC_BACKFILL_MAX_MS = 3300000;
const LOG_BACKFILL_MAX_MS = 14400000;
const LOG_BACKFILL_MAX_EVENTS = 600;

function ddEnv() {
  return {
    apiKey: process.env.DD_API_KEY,
    site: process.env.DD_SITE || 'us5.datadoghq.com',
  };
}

function jittered(value, jitter) {
  if (!jitter) return value;
  return value * (1 + (Math.random() * 2 - 1) * jitter);
}

/** Gentle day-shaped multiplier so baseline volume looks organic. */
function diurnalFactor(atMs) {
  const hour = new Date(atMs).getUTCHours() + new Date(atMs).getUTCMinutes() / 60;
  return 0.65 + 0.35 * Math.sin(((hour - 6) / 24) * 2 * Math.PI) * 0.5 + 0.35;
}

const TOKEN_FILLERS = {
  executionId: (rand = Math.random) => String(100000 + Math.floor(rand() * 900000)),
  workflowId: (rand = Math.random) => `wf_${rand().toString(36).slice(2, 10)}`,
  jobId: (rand = Math.random) => String(40000 + Math.floor(rand() * 60000)),
  batchId: (rand = Math.random) => `b_${rand().toString(36).slice(2, 10)}`,
  tickId: (rand = Math.random) => String(800000 + Math.floor(rand() * 200000)),
  ip: (rand = Math.random) => `10.${Math.floor(rand() * 256)}.${Math.floor(rand() * 256)}.${Math.floor(rand() * 254) + 1}`,
  ms: (rand = Math.random) => String(200 + Math.floor(rand() * 4800)),
  n: (rand = Math.random) => String(1 + Math.floor(rand() * 14)),
  m: (rand = Math.random) => String(1 + Math.floor(rand() * 6)),
  attempt: (rand = Math.random) => String(1 + Math.floor(rand() * 8)),
  version: () => `v${new Date().toISOString().slice(0, 10).replace(/-/g, '.')}-1`,
};

function renderTemplate(template, overrides = {}) {
  return template.replace(/\{(\w+)\}/g, (match, token) => {
    if (overrides[token] != null) return overrides[token];
    return TOKEN_FILLERS[token] ? TOKEN_FILLERS[token]() : match;
  });
}

function seededRandom(seed) {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  let value = hash >>> 0 || 1;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

/**
 * A cadence spec models a queue job's whole life instead of a log rate: one
 * job is born every `birthIntervalMs`, fails `attempts` times spaced
 * `attemptIntervalMs` apart, then stops (dead-lettered). Identities are
 * derived from the absolute clock and the run ref rather than handed out by
 * a counter, so backfilled history, live emission and a resumed process all
 * compute the same job ids for the same instant — a job's redeliveries stay
 * intact across the declaration boundary and across restarts.
 *
 * Specs sharing a cadence `id` and a token draw the same value for the same
 * job: the cursor warning names the tick its failures cite. Without that,
 * warnings and failures never join, which is itself evidence — and it is
 * exactly the join an investigator runs to test whether two code paths are
 * the same one.
 */
function cadenceIdentity(seed, cadence, index) {
  const values = {};
  for (const token of cadence.tokens || []) {
    const rand = seededRandom(`${seed}|${cadence.id}|${token}|${index}`);
    values[token] = TOKEN_FILLERS[token] ? TOKEN_FILLERS[token](rand) : `{${token}}`;
  }
  return values;
}

/**
 * The events a cadence spec produces in [fromMs, toMs). `bornAfterMs` and
 * `bornBeforeMs` bound which jobs exist: the outage spec only births jobs
 * from the phase start, and the drain that replaces it at mitigation births
 * none at all — the jobs already in flight keep failing until they exhaust
 * their redeliveries, which is what recovery actually looks like from the
 * outside.
 */
function cadenceEvents(spec, seed, fromMs, toMs, { bornAfterMs, bornBeforeMs } = {}) {
  const cadence = spec.cadence;
  const birthMs = Math.max(cadence.birthIntervalMs || 60000, 1);
  const attempts = Math.max(cadence.attempts || 1, 1);
  const attemptMs = cadence.attemptIntervalMs || birthMs;
  const offsetMs = cadence.offsetMs || 0;
  const jitterMs = cadence.jitterMs || 0;
  const lifetimeMs = offsetMs + (attempts - 1) * attemptMs + jitterMs;
  const events = [];
  const firstIndex = Math.floor((Math.max(fromMs, bornAfterMs || fromMs) - lifetimeMs) / birthMs);
  const lastIndex = Math.floor(toMs / birthMs);
  for (let index = firstIndex; index <= lastIndex; index++) {
    const bornAt = index * birthMs;
    if (Number.isFinite(bornAfterMs) && bornAt < bornAfterMs) continue;
    if (Number.isFinite(bornBeforeMs) && bornAt >= bornBeforeMs) break;
    let identity = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const rand = seededRandom(`${seed}|${cadence.id}|${index}|${attempt}`);
      const at = bornAt + offsetMs + attempt * attemptMs + Math.round((rand() * 2 - 1) * jitterMs);
      if (at < fromMs || at >= toMs) continue;
      identity = identity || cadenceIdentity(seed, cadence, index);
      events.push({
        logger: spec.logger,
        status: spec.status,
        message: renderTemplate(spec.template, identity),
        timestamp: at,
      });
    }
  }
  return events;
}

function metricKey(spec) {
  return `${spec.metric}|${(spec.tags || []).join(',')}`;
}

function createDatadogSink({ post = axios.post } = {}) {
  let state = null;

  /** Per-run service identity — see engine.armImpl. Falls back to the
   *  scenario's base service for runs persisted before it existed. */
  function serviceName(run) {
    return run.telemetryService || run.scenario.service;
  }

  function baseTags(run) {
    return [
      `service:${serviceName(run)}`,
      `env:${run.scenario.env || 'production'}`,
      'source:incident-lab',
    ];
  }

  async function submitMetrics(run, series) {
    const { apiKey, site } = ddEnv();
    if (!apiKey || !series.length) return;
    await post(
      `https://api.${site}/api/v2/series`,
      {
        series: series.map((s) => ({
          metric: `${run.scenario.datadog.metricPrefix}.${s.metric}`,
          type: 1,
          points: s.points,
          tags: [...baseTags(run), ...(s.tags || [])],
        })),
      },
      { headers: { 'DD-API-KEY': apiKey, 'Content-Type': 'application/json' }, timeout: 10000 },
    );
  }

  async function submitLogs(run, events) {
    const { apiKey, site } = ddEnv();
    if (!apiKey || !events.length) return;
    await post(
      `https://http-intake.logs.${site}/api/v2/logs`,
      events.map((e) => ({
        ddsource: 'nodejs',
        ddtags: [...baseTags(run), `logger:${e.logger || 'app'}`].join(','),
        service: serviceName(run),
        status: e.status || 'info',
        message: e.message,
        timestamp: e.timestamp,
        hostname: `${serviceName(run)}-${1 + Math.floor(Math.random() * 4)}`,
      })),
      { headers: { 'DD-API-KEY': apiKey, 'Content-Type': 'application/json' }, timeout: 15000 },
    );
  }

  /** Accumulate fractional per-flush counts so low rates still emit. */
  function accrue(map, key, perMinute, jitter) {
    const inc = jittered((perMinute / 60000) * FLUSH_INTERVAL_MS, jitter);
    map.set(key, (map.get(key) || 0) + Math.max(inc, 0));
  }

  async function flush(run) {
    if (!state || state.stopped) return;
    const now = Date.now();
    const factor = diurnalFactor(now);
    const series = [];
    const logs = [];

    for (const [, spec] of state.metricRates) {
      const perMinute = spec.perMinute * (spec.diurnal ? factor : 1);
      accrue(state.metricAccrual, metricKey(spec), perMinute, spec.jitter);
      const owed = state.metricAccrual.get(metricKey(spec)) || 0;
      const count = Math.floor(owed);
      if (count >= 0) {
        state.metricAccrual.set(metricKey(spec), owed - count);
        series.push({ metric: spec.metric, tags: spec.tags, points: [{ timestamp: Math.floor(now / 1000), value: count }] });
      }
    }
    for (const spec of state.logRates) {
      if (spec.cadence) {
        logs.push(...cadenceEvents(spec, run.runRef, spec.lastEmitAt, now, spec));
        spec.lastEmitAt = now;
        continue;
      }
      const key = `${spec.logger}|${spec.template}`;
      accrue(state.logAccrual, key, spec.perHour / 60, 0.5);
      const owed = state.logAccrual.get(key) || 0;
      const count = Math.floor(owed);
      state.logAccrual.set(key, owed - count);
      for (let i = 0; i < count; i++) {
        logs.push({
          logger: spec.logger,
          status: spec.status,
          message: renderTemplate(spec.template),
          timestamp: now - Math.floor(Math.random() * FLUSH_INTERVAL_MS),
        });
      }
    }

    // Metrics and logs are independent intakes — a failure of one must not
    // suppress the other.
    try {
      await submitMetrics(run, series);
    } catch (error) {
      logger.warn('Incident Lab Datadog metric flush failed', { error: error.message });
    }
    try {
      await submitLogs(run, logs);
    } catch (error) {
      logger.warn('Incident Lab Datadog log flush failed', { error: error.message });
    }
  }

  /** @param elapsedMs how long the phase has already been running before
   *   now — an already-expired catch-up burst never re-fires, and a
   *   partially-elapsed one only runs for its remaining window. */
  function applyMetricSpecs(specs, elapsedMs = 0) {
    for (const spec of specs || []) {
      if (spec.replacesBaseline) state.metricRates.delete(metricKey(spec));
      if (Number.isFinite(spec.perMinute)) state.metricRates.set(metricKey(spec), spec);
      if (spec.catchUpBurst && Number.isFinite(spec.catchUpBurst.count)) {
        applyCatchUpBurst(spec, elapsedMs);
      }
    }
  }

  /** A catch-up burst layers `count` extra events over `windowMs` on top of
   *  the steady rate (e.g. backed-up jobs draining after mitigation). */
  function applyCatchUpBurst(spec, elapsedMs = 0) {
    const windowMs = spec.catchUpBurst.windowMs || 900000;
    const remainingMs = windowMs - elapsedMs;
    if (remainingMs <= 0) return;
    const burstSpec = {
      metric: spec.metric,
      tags: spec.tags,
      perMinute: spec.catchUpBurst.count / (windowMs / 60000),
      jitter: spec.jitter,
    };
    const key = `${metricKey(spec)}|catch-up`;
    state.metricRates.set(key, burstSpec);
    const timer = setTimeout(() => {
      if (state) state.metricRates.delete(key);
    }, remainingMs);
    if (timer.unref) timer.unref();
    state.timers.push(timer);
  }

  /**
   * @param elapsedMs how long the phase has already been running before now
   *   (negative-start phases); duration-limited logs only run live for what
   *   remains of their window, and expired ones never start.
   *
   * A spec with `replacesBaseline` retires any live spec with the same
   * logger+template first (e.g. a success log that must stop during an
   * outage); with `perHour` 0 it emits nothing itself.
   */
  function applyLogSpecs(specs, phaseId, elapsedMs = 0) {
    for (const spec of specs || []) {
      if (spec.replacesBaseline) {
        state.logRates = state.logRates.filter(
          (s) => !(s.logger === spec.logger && s.template === spec.template),
        );
      }
      if (!spec.cadence && !(spec.perHour > 0)) continue;
      const entry = { ...spec, phase: phaseId };
      if (spec.cadence) {
        const now = Date.now();
        entry.lastEmitAt = now;
        // `inherit` continues the jobs an earlier spec was already failing
        // instead of starting a new population.
        if (spec.cadence.inherit) entry.bornBeforeMs = now - elapsedMs;
        else entry.bornAfterMs = now - elapsedMs;
      }
      if (Number.isFinite(spec.durationMs)) {
        const remainingMs = spec.durationMs - elapsedMs;
        if (remainingMs <= 0) continue;
        state.logRates.push(entry);
        const timer = setTimeout(() => {
          state.logRates = state.logRates.filter((s) => s !== entry);
        }, remainingMs);
        if (timer.unref) timer.unref();
        state.timers.push(timer);
      } else {
        state.logRates.push(entry);
      }
    }
  }

  /**
   * Baseline specs that a negative-start phase retires with `replacesBaseline`
   * are withheld while armed: that phase backfills the pre-declaration window
   * the armed period sits inside, and intake cannot retract live points and
   * events already written there. Specs the phase does not replace keep
   * emitting, so the healthy noise around the outage is unaffected.
   */
  function withholdRetroactiveReplacements(phases) {
    for (const phase of phases || []) {
      if (!(Number.isFinite(phase.startMs) && phase.startMs < 0)) continue;
      for (const spec of phase.metrics || []) {
        if (spec.replacesBaseline) state.metricRates.delete(metricKey(spec));
      }
      for (const spec of phase.logs || []) {
        if (spec.replacesBaseline) {
          state.logRates = state.logRates.filter(
            (s) => !(s.logger === spec.logger && s.template === spec.template),
          );
        }
      }
    }
  }

  /**
   * Write the healthy "before" at arm: baseline log history from the intake
   * horizon back to the moment the earliest negative-start phase will claim
   * once the run declares. Without it the run's service has no telemetry
   * predating the outage, and an investigator can neither prove things were
   * ever healthy nor see when the failing began. Metrics are not backfilled
   * here — metric intake only accepts ~1h-old points, which the outage
   * window already spends.
   */
  async function backfillBaselineLogs(run) {
    const dd = run.scenario.datadog;
    const specs = (dd.baseline || {}).logs || [];
    const phaseStarts = (dd.phases || [])
      .map((p) => p.startMs)
      .filter((startMs) => Number.isFinite(startMs) && startMs < 0);
    if (!specs.length || !phaseStarts.length) return;
    // Healthy history ends where the *earliest possible* declaration would
    // put the start of the outage — arming time, since declaring is a manual
    // call away. Declaring later only widens the quiet gap between healthy
    // history and the outage backfill; it can never overlap it.
    const now = Date.now();
    const end = now + Math.min(...phaseStarts);
    const start = now - LOG_BACKFILL_MAX_MS;
    if (end <= start) return;
    const logs = [];
    for (const spec of specs) {
      const total = Math.min(
        Math.round((spec.perHour / 3600000) * (end - start)),
        LOG_BACKFILL_MAX_EVENTS,
      );
      for (let i = 0; i < total; i++) {
        logs.push({
          logger: spec.logger,
          status: spec.status,
          message: renderTemplate(spec.template),
          timestamp: start + Math.floor(Math.random() * (end - start)),
        });
      }
    }
    logs.sort((a, b) => a.timestamp - b.timestamp);
    try {
      for (let i = 0; i < logs.length; i += 200) {
        await submitLogs(run, logs.slice(i, i + 200));
      }
    } catch (error) {
      logger.warn('Incident Lab baseline log backfill failed', { error: error.message });
    }
  }

  /** Emit a phase's error-log history for the time it was already running
   *  before declaration (the detection gap), within intake limits. */
  async function backfillPhase(run, phase) {
    const now = Date.now();
    const sinceMs = Math.min(-phase.startMs, LOG_BACKFILL_MAX_MS);
    if (sinceMs <= 0) return;
    const logs = [];
    for (const spec of phase.logs || []) {
      if (spec.cadence) {
        // Same derivation the live flush uses, so a job whose redeliveries
        // straddle the declaration keeps its identity across the seam.
        const startedAt = now - sinceMs;
        const events = cadenceEvents(spec, run.runRef, startedAt, now, { bornAfterMs: startedAt });
        logs.push(...events.slice(-LOG_BACKFILL_MAX_EVENTS));
        const live = state && state.logRates.find(
          (s) => s.logger === spec.logger && s.template === spec.template,
        );
        if (live) live.lastEmitAt = now;
        continue;
      }
      // A duration-limited log only ran for the overlap of its window with
      // the pre-declaration period, anchored at the phase start.
      const activeMs = Number.isFinite(spec.durationMs)
        ? Math.min(spec.durationMs, sinceMs)
        : sinceMs;
      const total = Math.min(
        Math.round((spec.perHour / 3600000) * activeMs),
        LOG_BACKFILL_MAX_EVENTS,
      );
      for (let i = 0; i < total; i++) {
        logs.push({
          logger: spec.logger,
          status: spec.status,
          message: renderTemplate(spec.template),
          timestamp: now - sinceMs + Math.floor(Math.random() * activeMs),
        });
      }
    }
    const series = [];
    const metricSince = Math.min(sinceMs, METRIC_BACKFILL_MAX_MS);
    for (const spec of phase.metrics || []) {
      if (!Number.isFinite(spec.perMinute)) continue;
      const points = [];
      for (let t = now - metricSince; t < now; t += 60000) {
        points.push({
          timestamp: Math.floor(t / 1000),
          value: Math.max(Math.round(jittered(spec.perMinute, spec.jitter)), 0),
        });
      }
      series.push({ metric: spec.metric, tags: spec.tags, points });
    }
    logs.sort((a, b) => a.timestamp - b.timestamp);
    try {
      await submitMetrics(run, series);
    } catch (error) {
      logger.warn('Incident Lab Datadog metric backfill failed', { phase: phase.id, error: error.message });
    }
    try {
      for (let i = 0; i < logs.length; i += 200) {
        await submitLogs(run, logs.slice(i, i + 200));
      }
    } catch (error) {
      logger.warn('Incident Lab Datadog log backfill failed', { phase: phase.id, error: error.message });
    }
  }

  /** A delay that onStop can settle immediately, so an in-flight burst
   *  never stays pending after its run is stopped. */
  function cancellableDelay(forState, ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        forState.delayResolvers.delete(resolve);
        resolve();
      }, ms);
      if (timer.unref) timer.unref();
      forState.timers.push(timer);
      forState.delayResolvers.add(resolve);
    });
  }

  /**
   * A prelude with `backdateMs` is written in one pass with historical
   * timestamps (log intake accepts ~18h) instead of playing out in real
   * time — the presenter doesn't have to arm `backdateMs` early for the
   * burst to sit that far in the past. `intervalMs` spaces the backdated
   * timestamps; the metric point is clamped to what metric intake accepts.
   * A log spec with `sameMessage` renders its template once and repeats it
   * (one job redelivered `count` times), instead of `count` distinct events.
   * `sharedTokens` on the prelude renders those tokens once for the whole
   * burst, so specs describing the same event (a failure line and its
   * cursor warning) agree on ids; a spec's `offsetMs` shifts its backdated
   * timestamps (the warning lands seconds after the failure it follows).
   */
  async function burst(run, prelude) {
    // Capture the state this burst belongs to: onStop clears the module
    // state while a burst may still be awaiting delivery, and resuming
    // against the shared reference would throw (an unhandled rejection).
    const burstState = state;
    const backdateMs = Number.isFinite(prelude.backdateMs)
      ? Math.min(prelude.backdateMs, LOG_BACKFILL_MAX_MS)
      : 0;
    const shared = {};
    for (const token of prelude.sharedTokens || []) {
      shared[token] = TOKEN_FILLERS[token] ? TOKEN_FILLERS[token]() : `{${token}}`;
    }
    for (const spec of prelude.logs || []) {
      const fixedMessage = spec.sameMessage ? renderTemplate(spec.template, shared) : null;
      const message = () => fixedMessage ?? renderTemplate(spec.template, shared);
      if (backdateMs > 0) {
        if (!burstState || burstState.stopped || state !== burstState) return;
        const base = Date.now() - backdateMs + (spec.offsetMs || 0);
        const events = [];
        for (let i = 0; i < (spec.count || 1); i++) {
          events.push({
            logger: spec.logger,
            status: spec.status,
            message: message(),
            timestamp: base + i * (spec.intervalMs || 0),
          });
        }
        try {
          await submitLogs(run, events);
        } catch (error) {
          logger.warn('Incident Lab prelude burst failed', { error: error.message });
        }
        continue;
      }
      for (let i = 0; i < (spec.count || 1); i++) {
        if (!burstState || burstState.stopped || state !== burstState) return;
        try {
          await submitLogs(run, [{
            logger: spec.logger,
            status: spec.status,
            message: message(),
            timestamp: Date.now(),
          }]);
        } catch (error) {
          logger.warn('Incident Lab prelude burst failed', { error: error.message });
        }
        if (spec.intervalMs && i < spec.count - 1) {
          await cancellableDelay(burstState, spec.intervalMs);
        }
      }
    }
    if (!burstState || burstState.stopped || state !== burstState) return;
    const metricAgeMs = Math.min(backdateMs, METRIC_BACKFILL_MAX_MS);
    const series = (prelude.metrics || [])
      .filter((m) => Number.isFinite(m.count))
      .map((m) => ({
        metric: m.metric,
        tags: m.tags,
        points: [{ timestamp: Math.floor((Date.now() - metricAgeMs) / 1000), value: m.count }],
      }));
    if (series.length) {
      try {
        await submitMetrics(run, series);
      } catch (error) {
        logger.warn('Incident Lab prelude metric failed', { error: error.message });
      }
    }
  }

  /** Start baseline noise and schedule preludes. `sinceArmMs` shifts the
   *  prelude schedule for a resumed run: bursts already past never refire,
   *  future ones keep their original wall-clock moment. */
  function startTelemetry(run, sinceArmMs = 0) {
    const dd = run.scenario.datadog;
    if (!dd) return false;
    if (!ddEnv().apiKey) {
      logger.warn('Incident Lab: DD_API_KEY not configured — telemetry disabled');
      return false;
    }
    state = {
      stopped: false,
      metricRates: new Map(),
      metricAccrual: new Map(),
      logRates: [],
      logAccrual: new Map(),
      timers: [],
      delayResolvers: new Set(),
    };
    applyMetricSpecs((dd.baseline || {}).metrics);
    applyLogSpecs((dd.baseline || {}).logs, 'baseline');
    if (!run.declaredAt) withholdRetroactiveReplacements(dd.phases);
    state.interval = setInterval(() => flush(run), FLUSH_INTERVAL_MS);
    if (state.interval.unref) state.interval.unref();
    for (const prelude of dd.prelude || []) {
      const delayMs = (prelude.afterArmMs || 0) - sinceArmMs;
      if (sinceArmMs > 0 && delayMs < 0) continue;
      const timer = setTimeout(() => burst(run, prelude), Math.max(delayMs, 0));
      if (timer.unref) timer.unref();
      state.timers.push(timer);
    }
    logger.info('Incident Lab Datadog baseline started', {
      runRef: run.runRef,
      metrics: state.metricRates.size,
      logTemplates: state.logRates.length,
    });
    return true;
  }

  function teardown() {
    if (!state) return;
    state.stopped = true;
    if (state.interval) clearInterval(state.interval);
    for (const timer of state.timers) clearTimeout(timer);
    for (const resolve of state.delayResolvers) resolve();
    state.delayResolvers.clear();
    state = null;
  }

  return {
    name: 'datadog',

    async onArm(run) {
      if (!startTelemetry(run)) return;
      // A fresh arm writes the healthy pre-outage history; a resumed run
      // already wrote it at its original arm (onResume skips this path).
      if (!run.declaredAt) await backfillBaselineLogs(run);
    },

    async onDeclare(run) {
      const incident = await declareDatadogIncident({
        title: run.scenario.title,
        summary: run.scenario.summary,
        runRef: run.runRef,
        service: serviceName(run),
        repoUrl: run.scenario.repoUrl,
        severity: run.scenario.severity || 'SEV-1',
      });
      if (incident) {
        run.incident = incident;
        logger.info('Incident Lab Datadog incident declared', {
          runRef: run.runRef,
          publicId: incident.publicId,
        });
      } else if (process.env.DD_API_KEY && (process.env.DD_INCIDENT_APP_KEY || process.env.DD_APPLICATION_KEY)) {
        throw new Error('Datadog returned no incident');
      } else {
        logger.warn('Incident Lab: Datadog incident keys not configured — no incident declared');
      }
    },

    async onPhase(run, phase) {
      if (!state || state.stopped) return;
      const elapsedMs = Number.isFinite(phase.startMs) && phase.startMs < 0 ? -phase.startMs : 0;
      applyMetricSpecs(phase.metrics);
      applyLogSpecs(phase.logs, phase.id, elapsedMs);
      if (elapsedMs > 0) {
        await backfillPhase(run, phase);
      }
    },

    /** Reattach after a restart: baseline noise restarts and each already
     *  active phase's steady rates re-apply against its original activation
     *  time. History was backfilled when the phase first activated, so no
     *  re-backfill — only the live rates resume. */
    async onResume(run) {
      if (!startTelemetry(run, Date.now() - run.armedAt)) return;
      const phases = (run.scenario.datadog && run.scenario.datadog.phases) || [];
      for (const phaseId of run.phases) {
        const phase = phases.find((p) => p.id === phaseId);
        if (!phase) continue;
        const activatedAt = (run.phaseTimes || {})[phaseId];
        const elapsedMs = activatedAt
          ? Date.now() - activatedAt + (Number.isFinite(phase.startMs) && phase.startMs < 0 ? -phase.startMs : 0)
          : 0;
        applyMetricSpecs(phase.metrics, elapsedMs);
        applyLogSpecs(phase.logs, phase.id, elapsedMs);
      }
    },

    /** Restart pending: stop emitting but leave the Datadog incident open
     *  for the resumed process to pick back up. */
    async onSuspend() {
      teardown();
    },

    async onStop(run) {
      teardown();
      if (run.incident && run.incident.id) {
        try {
          await resolveDatadogIncident(run.incident.id);
        } catch (error) {
          logger.warn('Incident Lab: failed to resolve Datadog incident', { error: error.message });
        }
      }
    },
  };
}

module.exports = { createDatadogSink };
