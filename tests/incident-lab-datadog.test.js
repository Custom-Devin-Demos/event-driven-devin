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

  test('onStop resolves the Datadog incident', async () => {
    const run = makeRun();
    run.incident = { id: 'abc', publicId: 42 };
    await sink.onArm(run);
    await sink.onStop(run);
    expect(resolveDatadogIncident).toHaveBeenCalledWith('abc');
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
