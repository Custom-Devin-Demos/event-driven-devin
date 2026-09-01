const os = require('os');
const path = require('path');

process.env.INCIDENT_LAB_STATE_FILE = path.join(
  os.tmpdir(),
  `incident-lab-engine-test-${process.pid}-${Date.now()}.json`,
);

const engine = require('../app/services/incident-lab/engine');
const { loadRunState } = require('../app/services/incident-lab/persistence');
const {
  loadScenarios,
  getScenario,
  listScenarios,
  validateScenario,
} = require('../app/services/incident-lab/scenario');

describe('incident-lab scenario loader', () => {
  test('loads the flowforge scenario from config', () => {
    const scenario = getScenario('flowforge-scheduled-workflows');
    expect(scenario).not.toBeNull();
    expect(scenario.service).toBe('flowforge-orchestrator');
    expect(scenario.durationMs).toBeGreaterThan(0);
    expect(listScenarios().map((s) => s.id)).toContain('flowforge-scheduled-workflows');
  });

  test('every script line references a declared persona and is time-ordered', () => {
    for (const scenario of loadScenarios().values()) {
      const personaIds = new Set(scenario.personas.map((p) => p.id));
      let last = -1;
      for (const line of scenario.script) {
        expect(personaIds.has(line.persona)).toBe(true);
        expect(line.atMs).toBeGreaterThanOrEqual(last);
        last = line.atMs;
      }
    }
  });

  test('script and knowledge fit inside the scenario window', () => {
    for (const scenario of loadScenarios().values()) {
      for (const line of scenario.script) {
        expect(line.atMs).toBeLessThanOrEqual(scenario.durationMs);
      }
      for (const entry of scenario.knowledge || []) {
        expect(entry.unlockAtMs).toBeLessThanOrEqual(scenario.durationMs);
      }
    }
  });

  test('rejects malformed scenarios', () => {
    expect(() => validateScenario({}, 'x.json')).toThrow(/missing "id"/);
    expect(() => validateScenario({
      id: 'x', title: 't', summary: 's', service: 'svc', durationMs: 1000,
      personas: [{ id: 'a', username: 'A' }],
      script: [{ atMs: 0, persona: 'nope', text: 'hi' }],
    }, 'x.json')).toThrow(/unknown persona/);
    expect(() => validateScenario({
      id: 'x', title: 't', summary: 's', service: 'svc', durationMs: 1000,
      personas: [{ id: 'a', username: 'A' }],
      script: [
        { atMs: 500, persona: 'a', text: 'later' },
        { atMs: 100, persona: 'a', text: 'earlier' },
      ],
    }, 'x.json')).toThrow(/ordered by atMs/);
    expect(() => validateScenario({
      id: 'x', title: 't', summary: 's', service: 'svc', durationMs: 1000,
      personas: [{ id: 'a', username: 'A' }],
      script: [{ atMs: 5000, persona: 'a', text: 'too late' }],
    }, 'x.json')).toThrow(/beyond durationMs/);
    expect(() => validateScenario({
      id: 'x', title: 't', summary: 's', service: 'svc', durationMs: 1000,
      personas: [{ id: 'a', username: 'A' }],
      script: [],
      knowledge: [{ unlockAtMs: 5000, facts: ['f'] }],
    }, 'x.json')).toThrow(/beyond durationMs/);
    expect(() => validateScenario({
      id: 'x', title: 't', summary: 's', service: 'svc', durationMs: 1000,
      personas: [{ id: 'a', username: 'A' }],
      script: [],
      datadog: {
        metricPrefix: 'x',
        phases: [{ id: 'p', startMs: 0 }, { id: 'p', manual: true }],
      },
    }, 'x.json')).toThrow(/duplicate datadog phase id/);
  });
});

describe('incident-lab engine lifecycle', () => {
  afterEach(() => engine.resetForTests());

  test('arm → declare → phase → stop, with sink fan-out', async () => {
    const events = [];
    engine.registerSink({
      name: 'test',
      onArm: (run) => events.push(['arm', run.status]),
      onDeclare: (run) => {
        run.incident = { id: 'inc-test', publicId: 1 };
        events.push(['declare', run.status]);
      },
      onPhase: (_run, phase) => events.push(['phase', phase.id]),
      onStop: (_run, reason) => events.push(['stop', reason]),
    });

    const armed = await engine.arm('flowforge-scheduled-workflows');
    expect(armed.ok).toBe(true);
    expect(engine.status().status).toBe('armed');

    const declared = await engine.declare();
    expect(declared.ok).toBe(true);
    expect(engine.status().status).toBe('declared');

    // Negative-startMs phases (onset before declaration) activate immediately.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(engine.status().phases).toContain('onset');

    const manual = await engine.triggerPhase('mitigated');
    expect(manual.ok).toBe(true);
    expect(engine.status().phases).toContain('mitigated');

    const stopped = await engine.stop('test done');
    expect(stopped.ok).toBe(true);
    expect(engine.status().status).toBe('stopped');

    expect(events.map((e) => e[0])).toEqual(
      expect.arrayContaining(['arm', 'declare', 'phase', 'stop']),
    );
  });

  test('refuses double-arm and declare without arm', async () => {
    engine.registerSink({
      name: 'declaring',
      onDeclare: (run) => { run.incident = { id: 'inc-test', publicId: 1 }; },
    });
    expect((await engine.declare()).ok).toBe(false);
    await engine.arm('flowforge-scheduled-workflows');
    expect((await engine.arm('flowforge-scheduled-workflows')).ok).toBe(false);
    await engine.declare();
    expect((await engine.declare()).ok).toBe(false);
  });

  test('rejects unknown scenario and unknown phase', async () => {
    engine.registerSink({
      name: 'declaring',
      onDeclare: (run) => { run.incident = { id: 'inc-test', publicId: 1 }; },
    });
    expect((await engine.arm('nope')).ok).toBe(false);
    await engine.arm('flowforge-scheduled-workflows');
    await engine.declare();
    expect((await engine.triggerPhase('nope')).ok).toBe(false);
  });

  test('triggerPhase refuses timed (non-manual) phases', async () => {
    engine.registerSink({
      name: 'declaring',
      onDeclare: (run) => { run.incident = { id: 'inc-test', publicId: 1 }; },
    });
    await engine.arm('flowforge-scheduled-workflows');
    await engine.declare();
    const result = await engine.triggerPhase('red-herring-redis');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not manually triggerable/);
  });

  test('stop is idempotent — second stop does not rerun sink cleanup', async () => {
    let stops = 0;
    engine.registerSink({ name: 'counter', onStop: () => { stops += 1; } });
    await engine.arm('flowforge-scheduled-workflows');
    await engine.declare();
    expect((await engine.stop()).ok).toBe(true);
    expect((await engine.stop()).ok).toBe(false);
    expect(stops).toBe(1);
  });

  test('first sink to set run.incident wins', async () => {
    const first = { id: '1', publicId: '11' };
    engine.registerSink({ name: 'a', onDeclare: (run) => { run.incident = first; } });
    engine.registerSink({ name: 'b', onDeclare: (run) => { run.incident = { id: '2', publicId: '22' }; } });
    await engine.arm('flowforge-scheduled-workflows');
    const declared = await engine.declare();
    expect(declared.incident).toBe(first);
  });

  test('a stop during a slow declare does not schedule stale timers', async () => {
    engine.registerSink({
      name: 'slow',
      onDeclare: () => new Promise((resolve) => setTimeout(resolve, 30)),
    });
    await engine.arm('flowforge-scheduled-workflows');
    const declaring = engine.declare();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await engine.stop('interrupt');
    const declared = await declaring;
    expect(declared.ok).toBe(false);
    expect(engine.status().status).toBe('stopped');
    expect(engine.currentRun().timers).toHaveLength(0);
  });

  test('a failing sink does not break the lifecycle', async () => {
    engine.registerSink({
      name: 'broken',
      onArm: () => { throw new Error('boom'); },
    });
    const armed = await engine.arm('flowforge-scheduled-workflows');
    expect(armed.ok).toBe(true);
  });

  test('declare fails and re-arms when no sink declares an incident at all', async () => {
    await engine.arm('flowforge-scheduled-workflows');
    const declared = await engine.declare();
    expect(declared.ok).toBe(false);
    expect(declared.error).toMatch(/no sink declared an incident/);
    expect(engine.status().status).toBe('armed');
  });

  test('concurrent stop waits for an in-flight declare and cleans up its incident', async () => {
    const stops = [];
    engine.registerSink({
      name: 'slow-datadog',
      onDeclare: async (run) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        run.incident = { id: 'inc-race', publicId: 9 };
      },
      onStop: (run) => stops.push(run.incident && run.incident.id),
    });
    await engine.arm('flowforge-scheduled-workflows');
    const declarePromise = engine.declare();
    const stopPromise = engine.stop('concurrent stop');
    const [declared, stopped] = await Promise.all([declarePromise, stopPromise]);
    expect(declared.ok).toBe(true);
    expect(stopped.ok).toBe(true);
    // stop ran after declare settled, so it saw (and could resolve) the incident
    expect(stops).toEqual(['inc-race']);
    expect(engine.status().status).toBe('stopped');
  });

  test('a declaration failure with no incident re-arms the run and is retryable', async () => {
    let attempts = 0;
    engine.registerSink({
      name: 'flaky-datadog',
      onDeclare: (run) => {
        attempts++;
        if (attempts === 1) throw new Error('datadog 500');
        run.incident = { id: 'inc-1', publicId: 42 };
      },
    });
    await engine.arm('flowforge-scheduled-workflows');

    const failed = await engine.declare();
    expect(failed.ok).toBe(false);
    expect(failed.error).toMatch(/datadog 500/);
    expect(engine.status().status).toBe('armed');

    const retried = await engine.declare();
    expect(retried.ok).toBe(true);
    expect(engine.status().status).toBe('declared');
    expect(engine.currentRun().incident.publicId).toBe(42);
  });

  test('a sink failure after the incident exists stays isolated', async () => {
    engine.registerSink({
      name: 'datadog',
      onDeclare: (run) => { run.incident = { id: 'inc-1', publicId: 7 }; },
    });
    engine.registerSink({
      name: 'broken-personas',
      onDeclare: () => { throw new Error('slack down'); },
    });
    await engine.arm('flowforge-scheduled-workflows');
    const declared = await engine.declare();
    expect(declared.ok).toBe(true);
    expect(engine.status().status).toBe('declared');
  });
});

describe('incident-lab engine persistence (suspend/resume)', () => {
  afterEach(() => engine.resetForTests());

  test('mutations persist a snapshot and stop clears it', async () => {
    engine.registerSink({
      name: 'declaring',
      onDeclare: (run) => { run.incident = { id: 'inc-1', publicId: 7 }; },
    });
    await engine.arm('flowforge-scheduled-workflows');
    let saved = loadRunState();
    expect(saved.status).toBe('armed');
    expect(saved.scenarioId).toBe('flowforge-scheduled-workflows');

    await engine.declare();
    saved = loadRunState();
    expect(saved.status).toBe('declared');
    expect(saved.incident).toEqual({ id: 'inc-1', publicId: 7 });

    await engine.stop('done');
    expect(loadRunState()).toBeNull();
  });

  test('suspend keeps the snapshot and does not fan out onStop', async () => {
    const hooks = [];
    engine.registerSink({
      name: 'watching',
      onDeclare: (run) => { run.incident = { id: 'inc-1', publicId: 7 }; },
      onSuspend: () => hooks.push('suspend'),
      onStop: () => hooks.push('stop'),
    });
    await engine.arm('flowforge-scheduled-workflows');
    await engine.declare();
    const suspended = await engine.suspend('deploy');
    expect(suspended.ok).toBe(true);
    expect(hooks).toEqual(['suspend']);
    const saved = loadRunState();
    expect(saved.status).toBe('declared');
    expect(engine.currentRun().timers).toHaveLength(0);
  });

  test('resume rebuilds a declared run and fans out onResume', async () => {
    engine.registerSink({
      name: 'declaring',
      onDeclare: (run) => { run.incident = { id: 'inc-1', publicId: 7 }; },
    });
    await engine.arm('flowforge-scheduled-workflows');
    await engine.declare();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const beforePhases = engine.status().phases;
    const runRef = engine.status().runRef;
    await engine.suspend('deploy');

    // Simulate the restarted process: fresh engine state, same state file.
    jest.resetModules();
    const engine2 = require('../app/services/incident-lab/engine');
    const resumeHooks = [];
    engine2.registerSink({ name: 'resumer', onResume: (run) => resumeHooks.push(run.status) });
    const resumed = await engine2.resume();
    expect(resumed.ok).toBe(true);
    expect(resumed.runRef).toBe(runRef);
    expect(engine2.status().status).toBe('declared');
    expect(engine2.status().phases).toEqual(expect.arrayContaining(beforePhases));
    expect(resumeHooks).toEqual(['declared']);
    engine2.resetForTests();
  });

  test('resume without a persisted run is a no-op', async () => {
    const resumed = await engine.resume();
    expect(resumed.ok).toBe(false);
    expect(engine.status().status).toBe('idle');
  });

  test('resume refuses while a run is already active', async () => {
    await engine.arm('flowforge-scheduled-workflows');
    const resumed = await engine.resume();
    expect(resumed.ok).toBe(false);
  });
});
