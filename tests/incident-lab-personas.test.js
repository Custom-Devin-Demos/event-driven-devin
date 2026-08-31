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
    const prompt = buildResponderPrompt(scenario, midMs);
    for (const fact of unlockedFacts(scenario, midMs)) {
      expect(prompt.indexOf(fact)).toBeLessThan(prompt.indexOf('Facts NOT yet known'));
    }
    for (const fact of lockedFacts(scenario, midMs)) {
      expect(prompt.indexOf(fact)).toBeGreaterThan(prompt.indexOf('Facts NOT yet known'));
    }
    expect(prompt).toContain(scenario.llm.guardrails);
  });

  test('responder prompt never embeds participant transcript text', () => {
    const prompt = buildResponderPrompt(scenario, 1000000);
    expect(prompt).not.toContain('Recent transcript');
    expect(prompt).toContain('untrusted channel content');
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
        history: jest.fn()
          .mockResolvedValueOnce([])
          .mockResolvedValue([
            { type: 'message', ts: '2.0', text: 'what is the queue retry policy?' },
          ]),
        draft,
        activatePhase: jest.fn().mockResolvedValue({ ok: true }),
      },
    });

    const run = makeRun();
    await sink.onDeclare(run);
    await jest.advanceTimersByTimeAsync(15000); // channel lookup
    await jest.advanceTimersByTimeAsync(20000); // first poll: watermark only
    await jest.advanceTimersByTimeAsync(20000); // responder poll
    await jest.advanceTimersByTimeAsync(120000); // reply delay
    expect(draft).toHaveBeenCalled();
    expect(posted.some((p) => p.username === 'Diego Marek')).toBe(true);
    await sink.onStop(run);
  });

  test('responder answers Devin app (bot_profile) messages but skips its own persona posts', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const draft = jest.fn().mockResolvedValue(null);
    const personaName = scenario.personas[0].username;
    const sink = createSlackPersonaSink({
      deps: {
        findChannel: jest.fn().mockResolvedValue({ id: 'C123', name: 'incident-42-flowforge' }),
        join: jest.fn().mockResolvedValue(true),
        post: jest.fn().mockResolvedValue(),
        history: jest.fn()
          .mockResolvedValueOnce([])
          .mockResolvedValue([
            { type: 'message', ts: '3.0', text: 'checking the queue now', bot_profile: { name: 'Devin' } },
            { type: 'message', ts: '2.0', text: 'scripted line', username: personaName, bot_profile: { name: 'incident-lab' } },
          ]),
        draft,
        activatePhase: jest.fn().mockResolvedValue({ ok: true }),
      },
    });

    const run = makeRun();
    await sink.onDeclare(run);
    await jest.advanceTimersByTimeAsync(15000); // channel lookup
    await jest.advanceTimersByTimeAsync(20000); // first poll: watermark only
    await jest.advanceTimersByTimeAsync(20000); // responder poll
    expect(draft).toHaveBeenCalledTimes(1);
    const transcript = draft.mock.calls[0][2];
    expect(transcript).toContain('checking the queue now');
    expect(transcript).not.toContain('scripted line');
    await sink.onStop(run);
  });

  test('a stopped run\u2019s pending channel lookup cannot hijack a newer run', async () => {
    let resolveFirstLookup;
    const firstLookup = new Promise((resolve) => { resolveFirstLookup = resolve; });
    const posted = [];
    const findChannel = jest.fn()
      .mockImplementationOnce(() => firstLookup)
      .mockResolvedValue({ id: 'C-NEW', name: 'incident-42-flowforge-new' });
    const sink = createSlackPersonaSink({
      deps: {
        findChannel,
        join: jest.fn().mockResolvedValue(true),
        post: jest.fn((token, channel, text) => {
          posted.push({ channel, text });
          return Promise.resolve();
        }),
        history: jest.fn().mockResolvedValue([]),
        activatePhase: jest.fn().mockResolvedValue({ ok: true }),
      },
    });

    const oldRun = makeRun({ runRef: 'LAB-OLD' });
    await sink.onDeclare(oldRun);
    await jest.advanceTimersByTimeAsync(15000); // old lookup starts, hangs
    await sink.onStop(oldRun);

    const newRun = makeRun({ runRef: 'LAB-NEW' });
    await sink.onDeclare(newRun);
    await jest.advanceTimersByTimeAsync(15000); // new lookup resolves C-NEW

    // Old run's lookup finally resolves with a stale channel — it must not
    // reschedule, post, or overwrite the new run's channel.
    resolveFirstLookup({ id: 'C-OLD', name: 'incident-42-flowforge-old' });
    await jest.advanceTimersByTimeAsync(scenario.durationMs + 1000);

    expect(posted.length).toBe(scenario.script.length);
    expect(posted.every((p) => p.channel === 'C-NEW')).toBe(true);
    await sink.onStop(newRun);
  });

  test('backlog at attachment is excluded but later investigator messages are drafted', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const draft = jest.fn().mockResolvedValue(null);
    const sink = createSlackPersonaSink({
      deps: {
        findChannel: jest.fn().mockResolvedValue({ id: 'C123', name: 'incident-42-flowforge' }),
        join: jest.fn().mockResolvedValue(true),
        post: jest.fn().mockResolvedValue(),
        history: jest.fn()
          .mockResolvedValueOnce([{ type: 'message', ts: '5.0', text: 'stale backlog message' }])
          .mockResolvedValue([
            { type: 'message', ts: '6.0', text: 'fresh investigator question' },
            { type: 'message', ts: '5.0', text: 'stale backlog message' },
          ]),
        draft,
        activatePhase: jest.fn().mockResolvedValue({ ok: true }),
      },
    });

    const run = makeRun();
    await sink.onDeclare(run);
    await jest.advanceTimersByTimeAsync(15000); // channel lookup + watermark init
    await jest.advanceTimersByTimeAsync(20000); // first poll
    expect(draft).toHaveBeenCalledTimes(1);
    const transcript = draft.mock.calls[0][2];
    expect(transcript).toContain('fresh investigator question');
    expect(transcript).not.toContain('stale backlog message');
    await sink.onStop(run);
  });

  test('a message posted while the watermark initializes is still drafted', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const draft = jest.fn().mockResolvedValue(null);
    // Posted after attachment (channel lookup resolves at +15s) but already
    // visible in the watermark-init history response — the race case.
    const racedTs = (Date.now() / 1000 + 16).toFixed(4);
    const sink = createSlackPersonaSink({
      deps: {
        findChannel: jest.fn().mockResolvedValue({ id: 'C123', name: 'incident-42-flowforge' }),
        join: jest.fn().mockResolvedValue(true),
        post: jest.fn().mockResolvedValue(),
        history: jest.fn().mockResolvedValue([
          { type: 'message', ts: racedTs, text: 'early investigator question' },
        ]),
        draft,
        activatePhase: jest.fn().mockResolvedValue({ ok: true }),
      },
    });

    const run = makeRun();
    await sink.onDeclare(run);
    await jest.advanceTimersByTimeAsync(15000); // channel lookup + watermark init
    await jest.advanceTimersByTimeAsync(20000); // first poll
    expect(draft).toHaveBeenCalledTimes(1);
    expect(draft.mock.calls[0][2]).toContain('early investigator question');
    await sink.onStop(run);
  });

  test('a rejected draft releases its reserved reply capacity', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const draft = jest.fn()
      .mockRejectedValueOnce(new Error('openai 500'))
      .mockResolvedValue({ persona: scenario.personas[0], text: 'recovered reply' });
    const posted = [];
    let ts = 10;
    const sink = createSlackPersonaSink({
      deps: {
        findChannel: jest.fn().mockResolvedValue({ id: 'C123', name: 'incident-42-flowforge' }),
        join: jest.fn().mockResolvedValue(true),
        post: jest.fn((token, channel, text, username) => {
          posted.push({ text, username });
          return Promise.resolve(`${ts++}.0`);
        }),
        history: jest.fn()
          .mockResolvedValueOnce([])
          .mockImplementation(() => Promise.resolve([
            { type: 'message', ts: `${ts++}.5`, text: 'investigator question' },
          ])),
        draft,
        activatePhase: jest.fn().mockResolvedValue({ ok: true }),
      },
    });

    const run = makeRun();
    run.scenario = { ...scenario, script: [], llm: { ...scenario.llm, maxRepliesPerRun: 1 } };
    await sink.onDeclare(run);
    await jest.advanceTimersByTimeAsync(15000); // channel lookup + watermark init
    await jest.advanceTimersByTimeAsync(20000); // poll: draft rejects, capacity released
    await jest.advanceTimersByTimeAsync(20000); // poll: draft succeeds within the cap
    await jest.advanceTimersByTimeAsync(120000); // reply delay
    expect(posted.some((p) => p.text === 'recovered reply')).toBe(true);
    await sink.onStop(run);
  });

  test('a slow draft cannot let overlapping polls exceed the reply cap', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    let resolveDraft;
    const draft = jest.fn(() => new Promise((resolve) => { resolveDraft = resolve; }));
    const posted = [];
    let ts = 10;
    const sink = createSlackPersonaSink({
      deps: {
        findChannel: jest.fn().mockResolvedValue({ id: 'C123', name: 'incident-42-flowforge' }),
        join: jest.fn().mockResolvedValue(true),
        post: jest.fn((token, channel, text, username) => {
          posted.push({ text, username });
          return Promise.resolve(`${ts++}.0`);
        }),
        history: jest.fn()
          .mockResolvedValueOnce([])
          .mockImplementation(() => Promise.resolve([
            { type: 'message', ts: `${ts++}.5`, text: 'another investigator question' },
          ])),
        draft,
        activatePhase: jest.fn().mockResolvedValue({ ok: true }),
      },
    });

    const run = makeRun();
    run.scenario = { ...scenario, script: [], llm: { ...scenario.llm, maxRepliesPerRun: 1 } };
    await sink.onDeclare(run);
    await jest.advanceTimersByTimeAsync(15000); // channel lookup
    await jest.advanceTimersByTimeAsync(20000); // first poll: watermark only
    await jest.advanceTimersByTimeAsync(20000); // poll starts, draft hangs
    await jest.advanceTimersByTimeAsync(20000); // overlapping poll must be skipped
    expect(draft).toHaveBeenCalledTimes(1);
    resolveDraft({ persona: scenario.personas[0], text: 'only reply' });
    await jest.advanceTimersByTimeAsync(120000); // reply delay + later polls
    expect(posted.filter((p) => p.text === 'only reply').length).toBe(1);
    expect(draft).toHaveBeenCalledTimes(1); // cap of 1 reached, no further drafts
    await sink.onStop(run);
  });
});
