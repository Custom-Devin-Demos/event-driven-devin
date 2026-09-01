process.env.INCIDENT_LAB_STATE_FILE = require('path').join(
  require('os').tmpdir(),
  `incident-lab-datadog-test-${process.pid}-${Date.now()}.json`,
);

jest.mock('../app/services/datadog-incidents', () => ({
  declareDatadogIncident: jest.fn(),
  resolveDatadogIncident: jest.fn(),
}));

const { declareDatadogIncident, resolveDatadogIncident } = require('../app/services/datadog-incidents');
const { createDatadogSink } = require('../app/services/incident-lab/datadog-emitter');
const { getScenario } = require('../app/services/incident-lab/scenario');

function makeRun() {
  return {
    runRef: 'LAB-TEST-00001',
    scenario: getScenario('flowforge-scheduled-workflows'),
    status: 'declared',
    incident: null,
    timers: [],
  };
}

describe('incident-lab datadog emitter', () => {
  let post;
  let sink;

  const savedEnv = {};

  beforeEach(() => {
    for (const key of ['DD_API_KEY', 'DD_INCIDENT_APP_KEY', 'DD_APPLICATION_KEY']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.DD_API_KEY = 'test-key';
    post = jest.fn().mockResolvedValue({ data: {} });
    sink = createDatadogSink({ post });
    declareDatadogIncident.mockReset().mockResolvedValue({ id: 'abc', publicId: 42 });
    resolveDatadogIncident.mockReset().mockResolvedValue(true);
  });

  afterEach(async () => {
    await sink.onStop(makeRun());
    for (const key of ['DD_API_KEY', 'DD_INCIDENT_APP_KEY', 'DD_APPLICATION_KEY']) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  test('onDeclare declares the incident with the scenario severity', async () => {
    const run = makeRun();
    await sink.onDeclare(run);
    expect(declareDatadogIncident).toHaveBeenCalledWith(expect.objectContaining({
      title: run.scenario.title,
      severity: run.scenario.severity,
      runRef: run.runRef,
    }));
    expect(run.incident).toEqual({ id: 'abc', publicId: 42 });
  });

  test('onDeclare tolerates missing Datadog incident keys', async () => {
    declareDatadogIncident.mockResolvedValue(null);
    const run = makeRun();
    await sink.onDeclare(run);
    expect(run.incident).toBeNull();
  });

  test('onDeclare fails loudly when keys are configured but no incident comes back', async () => {
    process.env.DD_INCIDENT_APP_KEY = 'test-app-key';
    declareDatadogIncident.mockResolvedValue(null);
    const run = makeRun();
    await expect(sink.onDeclare(run)).rejects.toThrow(/no incident/);
    expect(run.incident).toBeNull();
  });

  test('negative-start phase backfills namespaced metrics and logs', async () => {
    const run = makeRun();
    await sink.onArm(run);
    const onset = run.scenario.datadog.phases.find((p) => p.id === 'onset');
    await sink.onPhase(run, onset);

    const metricCalls = post.mock.calls.filter(([url]) => url.includes('/api/v2/series'));
    const logCalls = post.mock.calls.filter(([url]) => url.includes('http-intake.logs'));
    expect(metricCalls.length).toBeGreaterThan(0);
    expect(logCalls.length).toBeGreaterThan(0);

    for (const [, body] of metricCalls) {
      for (const series of body.series) {
        expect(series.metric).toMatch(/^flowforge\./);
        expect(series.tags).toEqual(expect.arrayContaining(['service:flowforge-orchestrator']));
      }
    }
    const sampleLog = logCalls[0][1][0];
    expect(sampleLog.service).toBe('flowforge-orchestrator');
    expect(sampleLog.message).not.toMatch(/\{\w+\}/);
  });

  test('a phase log spec with replacesBaseline retires the baseline template', async () => {
    jest.useFakeTimers();
    try {
      const run = { ...makeRun(), declaredAt: Date.now() };
      await sink.onArm(run);
      post.mockClear();
      await jest.advanceTimersByTimeAsync(120000);
      const armedMessages = post.mock.calls
        .filter(([url]) => url.includes('http-intake.logs'))
        .flatMap(([, body]) => body)
        .map((event) => event.message);
      expect(armedMessages.some((m) => m.startsWith('Enqueued execution batch'))).toBe(true);
      const onset = run.scenario.datadog.phases.find((p) => p.id === 'onset');
      await sink.onPhase(run, onset);
      post.mockClear();
      await jest.advanceTimersByTimeAsync(120000);
      const messages = post.mock.calls
        .filter(([url]) => url.includes('http-intake.logs'))
        .flatMap(([, body]) => body)
        .map((event) => event.message);
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.some((m) => m.startsWith('Enqueued execution batch'))).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  test('while armed, baseline specs a retroactive phase replaces are withheld', async () => {
    jest.useFakeTimers();
    try {
      const run = makeRun();
      await sink.onArm(run);
      post.mockClear();
      await jest.advanceTimersByTimeAsync(120000);
      const messages = post.mock.calls
        .filter(([url]) => url.includes('http-intake.logs'))
        .flatMap(([, body]) => body)
        .map((event) => event.message);
      expect(messages.some((m) => m.startsWith('Schedule tick'))).toBe(true);
      expect(messages.some((m) => m.startsWith('Enqueued execution batch'))).toBe(false);
      const series = post.mock.calls
        .filter(([url]) => url.includes('/api/v2/series'))
        .flatMap(([, body]) => body.series)
        .map((s) => `${s.metric}|${(s.tags || []).join(',')}`);
      expect(series.some((s) => s.includes('executions.started|') && s.includes('trigger:webhook'))).toBe(true);
      expect(series.some((s) => s.includes('executions.started|') && s.includes('trigger:schedule'))).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a backdated prelude burst lands immediately with historical timestamps', async () => {
    jest.useFakeTimers();
    try {
      const run = makeRun();
      await sink.onArm(run);
      await jest.advanceTimersByTimeAsync(70000);
      const events = post.mock.calls
        .filter(([url]) => url.includes('http-intake.logs'))
        .flatMap(([, body]) => body)
        .filter((event) => event.message.includes('InvalidBucketName'));
      expect(events).toHaveLength(8);
      for (const event of events) {
        expect(event.timestamp).toBeLessThan(Date.now() - 3600000);
      }
      expect(new Set(events.map((event) => event.message)).size).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('onStop resolves the Datadog incident', async () => {
    const run = makeRun();
    run.incident = { id: 'abc', publicId: 42 };
    await sink.onArm(run);
    await sink.onStop(run);
    expect(resolveDatadogIncident).toHaveBeenCalledWith('abc');
  });

  test('backfill still submits logs when metric intake fails', async () => {
    post.mockImplementation((url) =>
      (url.includes('/api/v2/series') ? Promise.reject(new Error('intake down')) : Promise.resolve({ data: {} })));
    const run = makeRun();
    await sink.onArm(run);
    const onset = run.scenario.datadog.phases.find((p) => p.id === 'onset');
    await sink.onPhase(run, onset);
    const logCalls = post.mock.calls.filter(([url]) => url.includes('http-intake.logs'));
    expect(logCalls.length).toBeGreaterThan(0);
  });

  test('expired duration-limited logs backfill but never emit live', async () => {
    jest.useFakeTimers();
    try {
      const run = makeRun();
      await sink.onArm(run);
      const redis = run.scenario.datadog.phases.find((p) => p.id === 'red-herring-redis');
      await sink.onPhase(run, redis);
      const backfilled = post.mock.calls.filter(([url, body]) =>
        url.includes('http-intake.logs') && body.some((e) => e.ddtags.includes('logger:flowforge.redis')));
      expect(backfilled.length).toBeGreaterThan(0);
      post.mockClear();
      await jest.advanceTimersByTimeAsync(120000);
      const live = post.mock.calls.filter(([url, body]) =>
        url.includes('http-intake.logs') && body.some((e) => e.ddtags.includes('logger:flowforge.redis')));
      expect(live).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('catchUpBurst layers a temporary recovery spike over the steady rate', async () => {
    jest.useFakeTimers();
    try {
      const run = makeRun();
      await sink.onArm(run);
      const mitigated = run.scenario.datadog.phases.find((p) => p.id === 'mitigated');
      await sink.onPhase(run, mitigated);
      post.mockClear();
      await jest.advanceTimersByTimeAsync(60000);
      let total = 0;
      for (const [url, body] of post.mock.calls) {
        if (!url.includes('/api/v2/series')) continue;
        for (const series of body.series) {
          if (series.metric !== 'flowforge.executions.started') continue;
          total += series.points.reduce((sum, p) => sum + p.value, 0);
        }
      }
      // Steady rate alone is 6/min (max ~8 with jitter); 220-over-15m adds ~14.7/min.
      expect(total).toBeGreaterThanOrEqual(10);
    } finally {
      jest.useRealTimers();
    }
  });

  test('prelude burst stops posting after onStop', async () => {
    jest.useFakeTimers();
    try {
      const run = makeRun();
      run.scenario = {
        ...run.scenario,
        datadog: {
          metricPrefix: 'flowforge',
          baseline: {},
          phases: [],
          prelude: [{
            afterArmMs: 0,
            logs: [{ count: 3, intervalMs: 1000, status: 'error', logger: 'flowforge.test', template: 'boom' }],
          }],
        },
      };
      await sink.onArm(run);
      await jest.advanceTimersByTimeAsync(0);
      const before = post.mock.calls.filter(([url]) => url.includes('http-intake.logs')).length;
      expect(before).toBe(1);
      await sink.onStop(run);
      // Stop settles the in-flight delay immediately: the burst promise
      // resolves without posting and without waiting out its interval.
      await Promise.resolve();
      await Promise.resolve();
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(5000);
      const after = post.mock.calls.filter(([url]) => url.includes('http-intake.logs')).length;
      expect(after).toBe(before);

      // A fresh arm after the interrupted burst behaves normally.
      await sink.onArm(run);
      await jest.advanceTimersByTimeAsync(0);
      const rearmed = post.mock.calls.filter(([url]) => url.includes('http-intake.logs')).length;
      expect(rearmed).toBe(before + 1);
      await sink.onStop(run);
    } finally {
      jest.useRealTimers();
    }
  });

  test('does nothing when DD_API_KEY is missing', async () => {
    delete process.env.DD_API_KEY;
    const run = makeRun();
    await sink.onArm(run);
    const onset = run.scenario.datadog.phases.find((p) => p.id === 'onset');
    await sink.onPhase(run, onset);
    expect(post).not.toHaveBeenCalled();
  });
});
