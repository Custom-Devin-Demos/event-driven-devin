jest.mock('../app/services/slack', () => ({
  findChannelByName: jest.fn(),
  joinChannel: jest.fn(),
  postPersonaMessage: jest.fn(),
  postUserMessage: jest.fn(),
  getThreadReplies: jest.fn(),
}));
jest.mock('../app/services/bot-pager', () => ({
  pageBot: jest.fn(),
}));

const pdlc = require('../app/services/verticals/9bfabd45-pdlc');
const script = require('../config/nexen/pdlc-personas.json');

const BOT = { user: 'U0CK6TNG7T3', bot_id: 'B0CK8N59ZLL' };
const png = [{ name: 'option-a.png', mimetype: 'image/png' }];

function fakeDeps({ botReplies, userReplies = [] }) {
  let clock = 1_000_000;
  let tsCounter = 1000;
  const thread = [];
  const posted = [];
  const pages = [];
  const deps = {
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    findChannelByName: jest.fn(async () => ({ id: 'C0PRODUCT', name: 'bny-pershing-android-app' })),
    joinChannel: jest.fn(async () => true),
    postPersonaMessage: jest.fn(async (_t, _c, text, username, _icon, threadTs) => {
      const ts = `${tsCounter += 1}.000100`;
      posted.push({ text, username, threadTs, ts });
      thread.push({ ts, text, username, bot_id: 'BPERSONA' });
      return ts;
    }),
    postUserMessage: jest.fn(async (token, _c, text, threadTs) => {
      const ts = `${tsCounter += 1}.000100`;
      posted.push({ text, token, threadTs, ts });
      thread.push({ ts, text, user: 'UHUMAN' });
      const reply = userReplies.shift();
      if (reply) thread.push({ ts: `${tsCounter += 1}.000200`, ...BOT, ...reply });
      return ts;
    }),
    getThreadReplies: jest.fn(async () => thread),
    pageBot: jest.fn(async ({ botId, message }) => {
      pages.push({ botId, message });
      const reply = botReplies[pages.length - 1];
      if (reply) thread.push({ ts: `${tsCounter += 1}.000200`, ...BOT, ...reply });
      return { sessionId: botId };
    }),
  };
  return { deps, posted, pages, thread };
}

beforeEach(() => {
  pdlc.resetPdlcForTests();
  process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
  delete process.env.BNY_PDLC_CHANNEL_ID;
  delete process.env.BNY_PDLC_BOT_ID;
  delete process.env.BNY_IOS_BOT_WEBHOOK_SECRET;
  delete process.env.BNY_IOS_BOT_WEBHOOK_URL;
  delete process.env.BNY_PDLC_PERSONA_USER_TOKENS;
});

test('plays the discussion, pages the Bot without an @mention and follows its replies to the PR', async () => {
  const { deps, posted, pages } = fakeDeps({
    botReplies: [
      { text: 'here are three options', files: png },
      { text: 'revised with a % slider, good to build?', files: png },
      { text: 'PR is up: https://github.com/COG-GTM/android-demos/pull/101 with preview' },
    ],
  });

  const { started, run } = pdlc.startPdlcRun({}, deps);
  expect(started).toBe(true);
  await run.done;

  expect(run.status).toBe('complete');
  expect(run.prUrl).toBe('https://github.com/COG-GTM/android-demos/pull/101');

  const texts = posted.map((p) => p.text);
  expect(texts).toEqual([
    ...script.discussion.map((l) => l.text),
    script.changeRequest.text,
    script.goAhead.text,
  ]);
  expect(script.wrapUp).toBeUndefined();
  expect(posted[0].threadTs).toBeUndefined();
  expect(posted.slice(1).every((p) => p.threadTs === posted[0].ts)).toBe(true);
  expect(texts.join(' ')).not.toMatch(/<@/);

  expect(pages).toHaveLength(3);
  expect(pages.every((p) => p.botId === 'bot-59656379ddc5470281166b1458334c2c')).toBe(true);
  expect(pages[0].message).toContain(`p${posted[0].ts.replace('.', '')}`);
  expect(pages[0].message).toContain(`Rachel Kim: ${script.discussion[0].text}`);
  expect(pages[1].message).toContain(script.changeRequest.text);
  expect(pages[2].message).toContain(script.goAhead.text);
});

test('stops waiting when the Bot never posts wireframes and allows no second run during cooldown', async () => {
  const { deps, posted } = fakeDeps({ botReplies: [{ text: 'on it, sketching now' }] });
  const { run } = pdlc.startPdlcRun({}, deps);
  await run.done;

  expect(run.status).toBe('stopped');
  expect(run.stage).toBe('timeout_wireframes');
  expect(posted).toHaveLength(script.discussion.length);
  expect(pdlc.startPdlcRun({}, deps)).toMatchObject({ started: false, reason: 'cooldown' });
});

test('rejects a second run while one is in progress', () => {
  const { deps } = fakeDeps({ botReplies: [] });
  deps.sleep = () => new Promise(() => {});
  expect(pdlc.startPdlcRun({}, deps).started).toBe(true);
  expect(pdlc.startPdlcRun({}, deps)).toMatchObject({ started: false, reason: 'already_running' });
});

test('records a failed page and keeps playing the discussion', async () => {
  const { deps, posted } = fakeDeps({ botReplies: [] });
  deps.pageBot.mockResolvedValue(null);
  const { run } = pdlc.startPdlcRun({}, deps);
  await run.done;
  expect(posted).toHaveLength(script.discussion.length);
  expect(run.pageFailures).toEqual(['join']);
  expect(deps.pageBot).toHaveBeenCalledTimes(4);
});

test('retries a failed page before giving up', async () => {
  const { deps } = fakeDeps({ botReplies: [] });
  deps.pageBot.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue({ via: 'webhook', status: 200 });
  const { run } = pdlc.startPdlcRun({}, deps);
  await run.done;
  expect(run.pageFailures).toEqual([]);
  expect(deps.pageBot).toHaveBeenCalledTimes(3);
});

test('detects Bot messages by member or app bot id and image attachments', () => {
  expect(pdlc.isBotMessage({ user: 'U0CK6TNG7T3' })).toBe(true);
  expect(pdlc.isBotMessage({ bot_id: 'B0CK8N59ZLL' })).toBe(true);
  expect(pdlc.isBotMessage({ user: 'U0OTHER', bot_id: 'BPERSONA' })).toBe(false);
  expect(pdlc.hasImages({ files: [{ name: 'wire.png' }] })).toBe(true);
  expect(pdlc.hasImages({ files: [{ name: 'notes.txt', mimetype: 'text/plain' }] })).toBe(false);
});

test('pages through the Bot-owned webhook when one is configured', async () => {
  process.env.BNY_IOS_BOT_WEBHOOK_SECRET = 'test-secret';
  process.env.BNY_IOS_BOT_WEBHOOK_URL = 'https://example.test/hook';
  process.env.BNY_PDLC_BOT_ID = 'off';
  const { deps } = fakeDeps({ botReplies: [] });
  const { run } = pdlc.startPdlcRun({}, deps);
  await run.done;
  expect(deps.pageBot).toHaveBeenCalledWith(expect.objectContaining({ webhookUrl: 'https://example.test/hook', webhookSecret: 'test-secret', botId: null }));
});

test('persona messages use each persona\'s shared BNY avatar on the public asset host', async () => {
  const { deps } = fakeDeps({ botReplies: [] });
  const { run } = pdlc.startPdlcRun({}, deps);
  await run.done;
  const icons = new Set(deps.postPersonaMessage.mock.calls.map((c) => c[4]));
  expect([...icons].sort()).toEqual([
    'https://devindemos.com/bny/avatars/rachel-kim.png',
    'https://devindemos.com/bny/avatars/sofia-alvarez.png',
    'https://devindemos.com/bny/avatars/tom-nguyen.png',
  ]);
});

test('treats an HTML wireframe artifact as the Bot\'s wireframes', () => {
  expect(pdlc.hasImages({ files: [{ name: 'holdings-price-alerts.html', mimetype: 'text/html' }] })).toBe(true);
  expect(pdlc.hasImages({ files: [{ name: 'notes.txt', mimetype: 'text/plain' }] })).toBe(false);
});

test('pages carry only the Slack lines; the Jira and owner steps live in the standing instructions', () => {
  const join = pdlc.buildJoinPage({ channelId: 'C123', threadTs: '1.2' });
  const relay = pdlc.buildRelayPage({ persona: script.personas[1], text: 'hi' });
  expect(join.split('\n')).toHaveLength(script.discussion.length + 1);
  expect(relay).toBe('#bny-pershing-android-app · Sofia Alvarez: hi');
  for (const page of [join, relay]) expect(page).not.toMatch(/demo|forwarded|relay|Answer it/i);
  const instructions = pdlc.buildBotInstructions();
  expect(instructions).toContain(`project ${script.jira.projectKey}`);
  expect(instructions).toContain(`assignee ${script.engineeringOwner.name}`);
  expect(instructions).toContain(`<@${script.engineeringOwner.slackId}>`);
  expect(instructions).toMatch(/title starts with the Jira key/);
});

test('docs/BNY-PDLC-BOT-INSTRUCTIONS.md matches the standing instructions', () => {
  const doc = require('fs').readFileSync(require('path').join(__dirname, '..', 'docs', 'BNY-PDLC-BOT-INSTRUCTIONS.md'), 'utf8');
  expect(doc).toBe(pdlc.buildBotInstructions());
});

test('a persona with a user token posts every line as that Slack member and is not paged when the Bot answers', async () => {
  process.env.BNY_PDLC_PERSONA_USER_TOKENS = JSON.stringify({ design: 'xoxp-hannah' });
  const { deps, posted, pages } = fakeDeps({
    botReplies: [
      { text: 'here are three options', files: png },
      { text: 'PR is up: https://github.com/COG-GTM/android-demos/pull/101' },
    ],
    userReplies: [null, { text: 'revised with a % slider, good to build?', files: png }],
  });
  const { run } = pdlc.startPdlcRun({}, deps);
  await run.done;
  expect(run.status).toBe('complete');
  const userPosts = posted.filter((p) => p.token);
  const designLines = script.discussion.filter((l) => l.persona === 'design').map((l) => l.text);
  expect(userPosts.map((p) => p.text)).toEqual([...designLines, script.changeRequest.text]);
  expect(userPosts.every((p) => p.token === 'xoxp-hannah')).toBe(true);
  expect(userPosts[userPosts.length - 1].threadTs).toBe(posted[0].ts);
  expect(pages.map((p) => p.message.split('\n')[0])).toEqual([
    expect.stringContaining('https://coggtm.slack.com/archives/'),
    `#bny-pershing-android-app · Rachel Kim: ${script.goAhead.text}`,
  ]);
  expect(run.userPostFallbacks).toEqual([]);
});

test('pages a user-token line when the Bot does not answer it in time', async () => {
  process.env.BNY_PDLC_PERSONA_USER_TOKENS = JSON.stringify({ design: 'xoxp-hannah' });
  const { deps, pages } = fakeDeps({
    botReplies: [{ text: 'here are three options', files: png }, { text: 'revised', files: png }],
  });
  const { run } = pdlc.startPdlcRun({}, deps);
  await run.done;
  expect(run.userPostFallbacks).toEqual(['design']);
  expect(pages[1].message).toBe(`#bny-pershing-android-app · Sofia Alvarez: ${script.changeRequest.text}`);
});

test('ignores a malformed BNY_PDLC_PERSONA_USER_TOKENS and posts through the app', async () => {
  process.env.BNY_PDLC_PERSONA_USER_TOKENS = '{not json';
  const { deps } = fakeDeps({ botReplies: [] });
  const { run } = pdlc.startPdlcRun({}, deps);
  await run.done;
  expect(deps.postUserMessage).not.toHaveBeenCalled();
});
