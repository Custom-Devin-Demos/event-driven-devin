const engine = require('../app/services/incident-lab/engine');
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
  });
});

describe('incident-lab engine lifecycle', () => {
  afterEach(() => engine.resetForTests());

  test('arm → declare → phase → stop, with sink fan-out', async () => {
    const events = [];
    engine.registerSink({
      name: 'test',
      onArm: (run) => events.push(['arm', run.status]),
      onDeclare: (run) => events.push(['declare', run.status]),
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
    expect((await engine.declare()).ok).toBe(false);
    await engine.arm('flowforge-scheduled-workflows');
    expect((await engine.arm('flowforge-scheduled-workflows')).ok).toBe(false);
    await engine.declare();
    expect((await engine.declare()).ok).toBe(false);
  });

  test('rejects unknown scenario and unknown phase', async () => {
    expect((await engine.arm('nope')).ok).toBe(false);
    await engine.arm('flowforge-scheduled-workflows');
    await engine.declare();
    expect((await engine.triggerPhase('nope')).ok).toBe(false);
  });

  test('a failing sink does not break the lifecycle', async () => {
    engine.registerSink({
      name: 'broken',
      onArm: () => { throw new Error('boom'); },
    });
    const armed = await engine.arm('flowforge-scheduled-workflows');
    expect(armed.ok).toBe(true);
  });
});
