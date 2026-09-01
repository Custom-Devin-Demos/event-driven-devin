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
  executionId: () => String(100000 + Math.floor(Math.random() * 900000)),
  workflowId: () => `wf_${Math.random().toString(36).slice(2, 10)}`,
  jobId: () => String(40000 + Math.floor(Math.random() * 60000)),
  batchId: () => `b_${Math.random().toString(36).slice(2, 10)}`,
  tickId: () => String(800000 + Math.floor(Math.random() * 200000)),
  ip: () => `10.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 254) + 1}`,
  ms: () => String(200 + Math.floor(Math.random() * 4800)),
  n: () => String(1 + Math.floor(Math.random() * 14)),
  m: () => String(1 + Math.floor(Math.random() * 6)),
};

function renderTemplate(template) {
  return template.replace(/\{(\w+)\}/g, (match, token) =>
    (TOKEN_FILLERS[token] ? TOKEN_FILLERS[token]() : match));
}

function metricKey(spec) {
  return `${spec.metric}|${(spec.tags || []).join(',')}`;
}

function createDatadogSink({ post = axios.post } = {}) {
  let state = null;

  function baseTags(run) {
    return [
      `service:${run.scenario.service}`,
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
        service: run.scenario.service,
        status: e.status || 'info',
        message: e.message,
        timestamp: e.timestamp,
        hostname: `${run.scenario.service}-${1 + Math.floor(Math.random() * 4)}`,
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
   */
  function applyLogSpecs(specs, phaseId, elapsedMs = 0) {
    for (const spec of specs || []) {
      const entry = { ...spec, phase: phaseId };
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

  /** Emit a phase's error-log history for the time it was already running
   *  before declaration (the detection gap), within intake limits. */
  async function backfillPhase(run, phase) {
    const now = Date.now();
    const sinceMs = Math.min(-phase.startMs, LOG_BACKFILL_MAX_MS);
    if (sinceMs <= 0) return;
    const logs = [];
    for (const spec of phase.logs || []) {
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

  async function burst(run, prelude) {
    // Capture the state this burst belongs to: onStop clears the module
    // state while a burst may still be awaiting delivery, and resuming
    // against the shared reference would throw (an unhandled rejection).
    const burstState = state;
    for (const spec of prelude.logs || []) {
      for (let i = 0; i < (spec.count || 1); i++) {
        if (!burstState || burstState.stopped || state !== burstState) return;
        try {
          await submitLogs(run, [{
            logger: spec.logger,
            status: spec.status,
            message: renderTemplate(spec.template),
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
    const series = (prelude.metrics || [])
      .filter((m) => Number.isFinite(m.count))
      .map((m) => ({
        metric: m.metric,
        tags: m.tags,
        points: [{ timestamp: Math.floor(Date.now() / 1000), value: m.count }],
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
      startTelemetry(run);
    },

    async onDeclare(run) {
      const incident = await declareDatadogIncident({
        title: run.scenario.title,
        summary: run.scenario.summary,
        runRef: run.runRef,
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
