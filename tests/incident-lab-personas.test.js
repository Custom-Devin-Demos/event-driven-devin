process.env.INCIDENT_LAB_STATE_FILE = require('path').join(
  require('os').tmpdir(),
  `incident-lab-personas-test-${process.pid}-${Date.now()}.json`,
);

const {
  createSlackPersonaSink,
  buildResponderPrompt,
  unlockedFacts,
  lockedFacts,
  renderLine,
  personaIcon,
  buildMitigationPrompt,
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

describe('incident-lab persona avatars', () => {
  test('an avatar path resolves against the demo host, an emoji is left alone', () => {
    const previous = process.env.ONCALL_DEMO_BASE_URL;
    process.env.ONCALL_DEMO_BASE_URL = 'https://demo.example.com/';
    expect(personaIcon({ avatar: '/incident-lab/avatars/ic.png', icon: ':x:' }))
      .toBe('https://demo.example.com/incident-lab/avatars/ic.png');
    expect(personaIcon({ icon: ':x:' })).toBe(':x:');
    if (previous === undefined) delete process.env.ONCALL_DEMO_BASE_URL;
    else process.env.ONCALL_DEMO_BASE_URL = previous;
  });

  test('every scripted persona has an avatar', () => {
    for (const persona of scenario.personas) {
      expect(personaIcon(persona)).toMatch(/^https:\/\/\S+\.png$/);
    }
  });
});

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

  test('invites configured users after joining, without blocking the script', async () => {
    process.env.INCIDENT_LAB_INVITE_USER_IDS = ' U111, U222 ,,';
    const posted = [];
    let rejectInvite;
    const invite = jest.fn(() => new Promise((resolve, reject) => { rejectInvite = reject; }));
    const sink = createSlackPersonaSink({
      deps: {
        findChannel: jest.fn().mockResolvedValue({ id: 'C123', name: 'incident-42-flowforge' }),
        join: jest.fn().mockResolvedValue(true),
        invite,
        post: jest.fn((token, channel, text, username) => {
          posted.push({ channel, text, username });
          return Promise.resolve();
        }),
        history: jest.fn().mockResolvedValue([]),
        activatePhase: jest.fn().mockResolvedValue({ ok: true }),
      },
    });

    const run = makeRun();
    await sink.onDeclare(run);
    await jest.advanceTimersByTimeAsync(15000); // channel lookup tick
    expect(invite).toHaveBeenCalledWith('xoxb-test', 'C123', ['U111', 'U222']);
    // The invite promise is still pending — the script must run regardless.
    await jest.advanceTimersByTimeAsync(scenario.durationMs + 1000);
    expect(posted.length).toBe(scenario.script.length);
    rejectInvite(new Error('missing_scope')); // swallowed, only logged
    await Promise.resolve();
    await sink.onStop(run);
    delete process.env.INCIDENT_LAB_INVITE_USER_IDS;
  });

  test('does not invite when INCIDENT_LAB_INVITE_USER_IDS is unset', async () => {
    const invite = jest.fn();
    const sink = createSlackPersonaSink({
      deps: {
        findChannel: jest.fn().mockResolvedValue({ id: 'C123', name: 'incident-42-flowforge' }),
        join: jest.fn().mockResolvedValue(true),
        invite,
        post: jest.fn().mockResolvedValue(),
        history: jest.fn().mockResolvedValue([]),
        activatePhase: jest.fn().mockResolvedValue({ ok: true }),
      },
    });
    const run = makeRun();
    await sink.onDeclare(run);
    await jest.advanceTimersByTimeAsync(15000);
    expect(invite).not.toHaveBeenCalled();
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
        matchMitigation: jest.fn().mockResolvedValue(null),
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
        matchMitigation: jest.fn().mockResolvedValue(null),
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
        matchMitigation: jest.fn().mockResolvedValue(null),
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
        matchMitigation: jest.fn().mockResolvedValue(null),
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

  test('a restart mid-hold still delivers the recovery beat instead of only its phase', async () => {
    const posted = [];
    const phases = [];
    const deps = {
      findChannel: jest.fn().mockResolvedValue({ id: 'C123', name: 'incident-42-flowforge' }),
      join: jest.fn().mockResolvedValue(true),
      post: jest.fn((token, channel, text) => {
        posted.push(text);
        return Promise.resolve();
      }),
      history: jest.fn().mockResolvedValue([]),
      activatePhase: jest.fn((id) => {
        phases.push(id);
        return Promise.resolve({ ok: true });
      }),
    };
    const sink = createSlackPersonaSink({ deps });
    const script = [{ persona: 'eng_a', text: 'recovery beat', atMs: 60000, action: 'mitigate' }];
    // Declared an hour ago, phase never activated: the beat was still held.
    const run = makeRun({
      scenario: { ...scenario, script, llm: { ...scenario.llm, director: false } },
      declaredAt: Date.now() - 3600000,
      phases: [],
    });

    await sink.onResume(run);
    await jest.advanceTimersByTimeAsync(60000);
    expect(posted).toContain('recovery beat');
    expect(phases).toEqual(['mitigated']);
    await sink.onStop(run);
  });

  test('a restart after the recovery beat landed does not repost it', async () => {
    const posted = [];
    const sink = createSlackPersonaSink({
      deps: {
        findChannel: jest.fn().mockResolvedValue({ id: 'C123', name: 'incident-42-flowforge' }),
        join: jest.fn().mockResolvedValue(true),
        post: jest.fn((token, channel, text) => {
          posted.push(text);
          return Promise.resolve();
        }),
        history: jest.fn().mockResolvedValue([]),
        activatePhase: jest.fn().mockResolvedValue({ ok: true }),
      },
    });
    const script = [{ persona: 'eng_a', text: 'recovery beat', atMs: 60000, action: 'mitigate' }];
    const run = makeRun({
      scenario: { ...scenario, script, llm: { ...scenario.llm, director: false } },
      declaredAt: Date.now() - 3600000,
      phases: ['mitigated'],
    });

    await sink.onResume(run);
    await jest.advanceTimersByTimeAsync(60000);
    expect(posted).not.toContain('recovery beat');
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
        matchMitigation: jest.fn().mockResolvedValue(null),
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
        matchMitigation: jest.fn().mockResolvedValue(null),
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

describe('incident-lab script director', () => {
  const BEAT = { persona: 'ic', text: 'scripted beat', atMs: 60000 };
  const LATER = { persona: 'biz', text: 'later beat', atMs: 600000 };

  beforeEach(() => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.OPENAI_API_KEY = 'sk-test';
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.OPENAI_API_KEY;
  });

  /** Runs `script` far enough for the investigator's message to reach the
   *  director and the first beat to come due. */
  async function runDirector(script, direct) {
    const posted = [];
    const phases = [];
    let ts = 10;
    const sink = createSlackPersonaSink({
      deps: {
        findChannel: jest.fn().mockResolvedValue({ id: 'C123', name: 'incident-42-flowforge' }),
        join: jest.fn().mockResolvedValue(true),
        post: jest.fn((token, channel, text) => {
          posted.push(text);
          return Promise.resolve(`${ts++}.0`);
        }),
        history: jest.fn()
          .mockResolvedValueOnce([])
          .mockImplementation(() => Promise.resolve([
            { type: 'message', ts: `${ts++}.5`, text: 'already ruled the deploy out' },
          ])),
        draft: jest.fn().mockResolvedValue(null),
        matchMitigation: jest.fn().mockResolvedValue(null),
        direct,
        activatePhase: jest.fn((id) => {
          phases.push(id);
          return Promise.resolve({ ok: true });
        }),
      },
    });
    const run = makeRun();
    run.scenario = { ...scenario, script, llm: { ...scenario.llm, maxRepliesPerRun: 0 } };
    await sink.onDeclare(run);
    await jest.advanceTimersByTimeAsync(15000); // channel lookup + watermark
    await jest.advanceTimersByTimeAsync(40000); // polls: investigator message seen
    await jest.advanceTimersByTimeAsync(10000); // first beat comes due
    return { posted, phases, direct, stop: () => sink.onStop(run) };
  }

  test('a beat the investigator already covered is dropped', async () => {
    const direct = jest.fn().mockResolvedValue({ decision: 'skip' });
    const { posted, direct: called, stop } = await runDirector([BEAT], direct);
    expect(called).toHaveBeenCalled();
    expect(posted).not.toContain('scripted beat');
    await stop();
  });

  test('a beat carrying a phase action is posted even when skipped', async () => {
    const direct = jest.fn().mockResolvedValue({ decision: 'skip' });
    const { posted, phases, stop } = await runDirector([{ ...BEAT, action: 'mitigate' }], direct);
    expect(posted).toContain('scripted beat');
    expect(phases).toContain('mitigated');
    await stop();
  });

  test('a director error leaves the beat exactly as scripted', async () => {
    const direct = jest.fn().mockRejectedValue(new Error('fireworks 500'));
    const { posted, stop } = await runDirector([BEAT], direct);
    expect(posted).toContain('scripted beat');
    await stop();
  });

  test('"advance" pulls the remaining beats forward', async () => {
    const direct = jest.fn()
      .mockResolvedValueOnce({ decision: 'advance' })
      .mockResolvedValue({ decision: 'post' });
    const { posted, stop } = await runDirector([BEAT, LATER], direct);
    expect(posted).toContain('scripted beat');
    expect(posted).not.toContain('later beat');
    // 600000 - 180000 leaves the queued beat due at 420000, not 600000.
    await jest.advanceTimersByTimeAsync(360000);
    expect(posted).toContain('later beat');
    await stop();
  });

  test('"advance" moves the knowledge clock with the beats', async () => {
    const direct = jest.fn()
      .mockResolvedValueOnce({ decision: 'advance' })
      .mockResolvedValue({ decision: 'post' });
    const { stop } = await runDirector([BEAT, LATER], direct);
    const beforeMs = direct.mock.calls[0][1];
    await jest.advanceTimersByTimeAsync(360000);
    // The second beat is judged 3 min further along the script than the wall
    // clock, so the facts its text depends on are already unlocked.
    expect(direct.mock.calls[1][1]).toBe(beforeMs + 360000 + 180000);
    await stop();
  });

  test('"hold" defers a beat, and a beat cannot be held forever', async () => {
    const direct = jest.fn().mockResolvedValue({ decision: 'hold' });
    const { posted, stop } = await runDirector([BEAT], direct);
    expect(posted).not.toContain('scripted beat');
    await jest.advanceTimersByTimeAsync(2 * 120000 + 1000);
    expect(posted).toContain('scripted beat'); // third verdict is forced to post
    await stop();
  });

  test('a beat carrying a phase action outwaits an ordinary one before it is forced', async () => {
    const direct = jest.fn().mockResolvedValue({ decision: 'hold' });
    const { posted, stop } = await runDirector([{ ...BEAT, action: 'mitigate' }], direct);

    await jest.advanceTimersByTimeAsync(2 * 120000 + 1000);
    expect(posted).not.toContain('scripted beat'); // an ordinary beat would be out of holds
    await jest.advanceTimersByTimeAsync(8 * 120000 + 1000);
    expect(posted).toContain('scripted beat');
    await stop();
  });

  test('overdue beats drain with a gap instead of landing together', async () => {
    const direct = jest.fn().mockResolvedValue({ decision: 'post' });
    const overdue = { persona: 'biz', text: 'overdue beat', atMs: 61000 };
    const random = jest.spyOn(Math, 'random').mockReturnValue(0.5); // mid drain gap
    try {
      const { posted, stop } = await runDirector([BEAT, overdue], direct);

      expect(posted).toEqual(['scripted beat']);
      await jest.advanceTimersByTimeAsync(19000);
      expect(posted).toEqual(['scripted beat']);
      await jest.advanceTimersByTimeAsync(26000);
      expect(posted).toEqual(['scripted beat', 'overdue beat']);
      await stop();
    } finally {
      random.mockRestore();
    }
  });
});

describe('incident-lab mitigation exchange', () => {
  const FLOOR = { persona: 'eng_a', text: 'scripted mitigate beat', atMs: 3000000, action: 'mitigate' };
  const WORKS = scenario.mitigations.options.find((o) => o.id === 'disable-poison-workflow');
  const FAILS = scenario.mitigations.options.find((o) => o.id === 'rollback-deploy');

  beforeEach(() => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.OPENAI_API_KEY = 'sk-test';
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.OPENAI_API_KEY;
  });

  /** Runs a script whose only beat is the scripted mitigation floor, with the
   *  investigator saying `said` in channel on every poll. */
  async function runExchange(matchMitigation, { script = [FLOOR] } = {}) {
    const posted = [];
    const phases = [];
    let ts = 10;
    const sink = createSlackPersonaSink({
      deps: {
        findChannel: jest.fn().mockResolvedValue({ id: 'C123', name: 'incident-42-flowforge' }),
        join: jest.fn().mockResolvedValue(true),
        post: jest.fn((token, channel, text) => {
          posted.push(text);
          return Promise.resolve(`${ts++}.0`);
        }),
        history: jest.fn()
          .mockResolvedValueOnce([])
          .mockImplementation(() => Promise.resolve([
            { type: 'message', ts: `${ts++}.5`, text: 'can someone pause the meridianfx weekly export?' },
          ])),
        draft: jest.fn().mockResolvedValue(null),
        matchMitigation,
        direct: jest.fn().mockResolvedValue({ decision: 'post' }),
        activatePhase: jest.fn((id) => {
          phases.push(id);
          return Promise.resolve({ ok: true });
        }),
      },
    });
    const run = makeRun();
    run.scenario = { ...scenario, script, llm: { ...scenario.llm, maxRepliesPerRun: 0 } };
    await sink.onDeclare(run);
    await jest.advanceTimersByTimeAsync(15000); // channel lookup + watermark
    await jest.advanceTimersByTimeAsync(40000); // polls: investigator message seen
    return { posted, phases, matchMitigation, stop: () => sink.onStop(run) };
  }

  test('an authored proposal is acknowledged, acted on, then reported', async () => {
    const match = jest.fn().mockResolvedValueOnce(WORKS).mockResolvedValue(null);
    const { posted, phases, stop } = await runExchange(match);

    expect(posted).toContain(WORKS.ack);
    expect(phases).toEqual([]); // nobody fixes it in the same breath
    await jest.advanceTimersByTimeAsync(120000);
    expect(phases).toEqual(['mitigated']);
    expect(posted).not.toContain(WORKS.observation); // the curve needs time
    await jest.advanceTimersByTimeAsync(240000);
    expect(posted).toContain(WORKS.observation);
    await stop();
  });

  test('the matcher only sees the scenario\u2019s own options, and only untried ones', async () => {
    const match = jest.fn().mockResolvedValueOnce(WORKS).mockResolvedValue(null);
    const { stop } = await runExchange(match);
    const offered = match.mock.calls[0][1];
    expect(offered.map((o) => o.id)).toEqual(scenario.mitigations.options.map((o) => o.id));
    await jest.advanceTimersByTimeAsync(60000); // another poll, same proposal
    const laterOffers = match.mock.calls[match.mock.calls.length - 1][1];
    expect(laterOffers.map((o) => o.id)).not.toContain(WORKS.id);
    await stop();
  });

  test('a proposal the telemetry cannot honour recovers nothing', async () => {
    const match = jest.fn().mockResolvedValueOnce(FAILS).mockResolvedValue(null);
    const { posted, phases, stop } = await runExchange(match);

    await jest.advanceTimersByTimeAsync(360000);
    expect(posted).toContain(FAILS.ack);
    expect(posted).toContain(FAILS.observation);
    expect(phases).toEqual([]);
    await stop();
  });

  test('nothing happens without a match, and a matcher error is not a mitigation', async () => {
    const { posted, phases, stop } = await runExchange(jest.fn().mockResolvedValue(null));
    await jest.advanceTimersByTimeAsync(360000);
    expect(posted).toEqual([]);
    expect(phases).toEqual([]);
    await stop();

    const broken = await runExchange(jest.fn().mockRejectedValue(new Error('fireworks 500')));
    await jest.advanceTimersByTimeAsync(360000);
    expect(broken.posted).toEqual([]);
    expect(broken.phases).toEqual([]);
    await broken.stop();
  });

  test('the scripted beat is the floor when no one proposes anything', async () => {
    const { posted, phases, stop } = await runExchange(jest.fn().mockResolvedValue(null));
    await jest.advanceTimersByTimeAsync(3000000);
    expect(posted).toContain('scripted mitigate beat');
    expect(phases).toEqual(['mitigated']);
    await stop();
  });

  test('the exchange replaces the scripted beat rather than repeating it', async () => {
    const match = jest.fn().mockResolvedValueOnce(WORKS).mockResolvedValue(null);
    const { posted, phases, stop } = await runExchange(match);
    await jest.advanceTimersByTimeAsync(3000000);
    expect(posted).not.toContain('scripted mitigate beat');
    expect(phases).toEqual(['mitigated']);
    await stop();
  });

  test('the prompt lists only authored options and refuses to invent one', () => {
    const prompt = buildMitigationPrompt(scenario, scenario.mitigations.options);
    for (const option of scenario.mitigations.options) {
      expect(prompt).toContain(option.id);
      expect(prompt).toContain(option.proposal);
    }
    expect(prompt).toContain('Never invent');
    expect(prompt).toContain('untrusted');
  });
});
