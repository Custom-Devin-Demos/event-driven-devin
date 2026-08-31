const {
  createSlackPersonaSink,
  buildResponderPrompt,
  unlockedFacts,
  lockedFacts,
  renderLine,
} = require('../app/services/incident-lab/personas');
const { getScenario } = require('../app/services/incident-lab/scenario');

const scenario = getScenario('flowforge-scheduled-workflows');

function makeRun(overrides = {}) {
  return {
    runRef: 'LAB-TEST-00001',
    scenario,
    status: 'declared',
    declaredAt: Date.now(),
    incident: { id: 'abc', publicId: 42 },
    timers: [],
    ...overrides,
  };
}

describe('incident-lab persona knowledge gating', () => {
  test('facts unlock as the timeline advances', () => {
    const early = unlockedFacts(scenario, 0);
    const late = unlockedFacts(scenario, scenario.durationMs);
    expect(late.length).toBeGreaterThan(early.length);
    expect(lockedFacts(scenario, 0).length + early.length).toBe(late.length);
  });

  test('responder prompt separates known from locked facts', () => {
    const midMs = 1000000;
    const prompt = buildResponderPrompt(scenario, midMs, 'investigator: which project is affected?');
    for (const fact of unlockedFacts(scenario, midMs)) {
      expect(prompt.indexOf(fact)).toBeLessThan(prompt.indexOf('Facts NOT yet known'));
    }
    for (const fact of lockedFacts(scenario, midMs)) {
      expect(prompt.indexOf(fact)).toBeGreaterThan(prompt.indexOf('Facts NOT yet known'));
    }
    expect(prompt).toContain(scenario.llm.guardrails);
  });

  test('renderLine substitutes the Devin mention', () => {
    process.env.DEVIN_SLACK_USER_ID = 'U123';
    expect(renderLine('{devin} take a look')).toBe('<@U123> take a look');
    delete process.env.DEVIN_SLACK_USER_ID;
    expect(renderLine('{devin} take a look')).toBe('Devin take a look');
  });
});

describe('incident-lab slack persona sink', () => {
  beforeEach(() => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.OPENAI_API_KEY;
  });

  test('locates the Datadog incident channel, joins, and posts the script', async () => {
    const posted = [];
    const phases = [];
    const sink = createSlackPersonaSink({
      deps: {
        findChannel: jest.fn().mockResolvedValue({ id: 'C123', name: 'incident-42-flowforge' }),
        join: jest.fn().mockResolvedValue(true),
        post: jest.fn((token, channel, text, username) => {
          posted.push({ channel, text, username });
          return Promise.resolve();
        }),
        history: jest.fn().mockResolvedValue([]),
        activatePhase: jest.fn((id) => {
          phases.push(id);
          return Promise.resolve({ ok: true });
        }),
      },
    });

    const run = makeRun();
    await sink.onDeclare(run);
    await jest.advanceTimersByTimeAsync(15000); // channel lookup tick
    await jest.advanceTimersByTimeAsync(scenario.durationMs + 1000);

    expect(posted.length).toBe(scenario.script.length);
    expect(posted[0].channel).toBe('C123');
    expect(posted.some((p) => p.username === 'Jordan Reyes (IC)')).toBe(true);
    expect(phases).toContain('mitigated');
    await sink.onStop(run);
  });

  test('skips entirely when there is no Datadog incident public id', async () => {
    const findChannel = jest.fn();
    const sink = createSlackPersonaSink({ deps: { findChannel } });
    await sink.onDeclare(makeRun({ incident: null }));
    await jest.advanceTimersByTimeAsync(60000);
    expect(findChannel).not.toHaveBeenCalled();
  });

  test('responder replies in character to investigator messages', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const posted = [];
    const draft = jest.fn().mockResolvedValue({
      persona: scenario.personas.find((p) => p.id === 'eng_b'),
      text: 'redrive is maxReceiveCount=8, visibility ~2m',
    });
    const sink = createSlackPersonaSink({
      deps: {
        findChannel: jest.fn().mockResolvedValue({ id: 'C123', name: 'incident-42-flowforge' }),
        join: jest.fn().mockResolvedValue(true),
        post: jest.fn((token, channel, text, username) => {
          posted.push({ text, username });
          return Promise.resolve();
        }),
        history: jest.fn().mockResolvedValue([
          { type: 'message', ts: '2.0', text: 'what is the queue retry policy?' },
        ]),
        draft,
        activatePhase: jest.fn().mockResolvedValue({ ok: true }),
      },
    });

    const run = makeRun();
    await sink.onDeclare(run);
    await jest.advanceTimersByTimeAsync(15000); // channel lookup
    await jest.advanceTimersByTimeAsync(20000); // responder poll
    await jest.advanceTimersByTimeAsync(120000); // reply delay
    expect(draft).toHaveBeenCalled();
    expect(posted.some((p) => p.username === 'Diego Marek')).toBe(true);
    await sink.onStop(run);
  });
});
