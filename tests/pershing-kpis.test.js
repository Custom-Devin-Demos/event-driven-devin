jest.mock('../app/services/slack', () => ({
  postPersonaMessage: jest.fn(() => Promise.resolve('1795000000.000100')),
  inviteToChannel: jest.fn(() => Promise.resolve(true)),
  joinChannel: jest.fn(() => Promise.resolve(true)),
  getThreadReplies: jest.fn(() => Promise.resolve([])),
  getChannelHistory: jest.fn(() => Promise.resolve([])),
  deleteMessage: jest.fn(() => Promise.resolve(true)),
}));
jest.mock('../app/services/devin-api', () => ({
  sendDevinSessionMessage: jest.fn(() => Promise.resolve({ sessionId: 'bot-3a43e8d41c194bbe82bdaed7f6af36e2', url: 'https://app.devin.ai/bots/x' })),
}));

jest.mock('axios', () => ({ post: jest.fn(() => Promise.resolve({ status: 200, data: { ok: true, ts: '1795000000.000100' } })) }));

const axios = require('axios');
const {
  postPersonaMessage, inviteToChannel, getThreadReplies, getChannelHistory, deleteMessage,
} = require('../app/services/slack');
const { sendDevinSessionMessage } = require('../app/services/devin-api');
const kpis = require('../app/services/pershing-kpis');

describe('Pershing Access KPI posts', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    kpis.resetState();
    process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
    delete process.env.PERSHING_KPI_BOT_WEBHOOK_URL;
    delete process.env.BNY_IOS_BOT_WEBHOOK_SECRET;
    delete process.env.PERSHING_KPI_BOT_WEBHOOK_SECRET;
    delete process.env.PERSHING_KPI_PAGE_BOT;
  });
  afterEach(() => jest.useRealTimers());

  test('labels each post with its date and day-over-day deltas', () => {
    const { text, analysis } = kpis.renderDay('2026-11-12');
    expect(text).toContain('Thu, Nov 12, 2026');
    expect(text).toMatch(/DoD/);
    expect(analysis.isDrop).toBe(false);
  });

  test('keeps Nov 5-18 green and flags Thu Nov 19 transfer screen load creep (not an incident)', () => {
    ['2026-11-11', '2026-11-12', '2026-11-16', '2026-11-18'].forEach((d) => expect(kpis.analyzeDay(d).isDrop).toBe(false));
    const flag = kpis.analyzeDay('2026-11-19');
    expect(flag.isNewDrop).toBe(true);
    expect(flag.creepPct).toBeCloseTo(46.4, 1);
    const { text } = kpis.renderDay('2026-11-19');
    expect(text).toMatch(/^:large_yellow_circle:/);
    expect(text).toContain('Android transfer screen load is 46% above its pre-2.4.0 baseline (1.10 s)');
    expect(text).toContain('transfer completion is healthy');
    expect(kpis.renderDay('2026-11-12').text).toContain('on 10% of Android sessions, staged rollout started today');
    expect(kpis.analyzeDay('2026-11-20').isDrop).toBe(true);
    expect(kpis.analyzeDay('2026-11-20').isNewDrop).toBe(false);
  });

  test('seed posts the 14 normal days Nov 5-18 without paging the Bot', async () => {
    const run = await kpis.seed();
    expect(run.posts.map((p) => p.date)).toHaveLength(14);
    expect(run.posts[0].date).toBe('2026-11-05');
    expect(run.posts[13].date).toBe('2026-11-18');
    expect(axios.post.mock.calls.filter((c) => c[0].endsWith('chat.postMessage'))).toHaveLength(14);
    expect(axios.post.mock.calls[0][1].blocks[1].image_url).toBe('https://devindemos.com/pershing/kpi/2026-11-05.png');
    expect(sendDevinSessionMessage).not.toHaveBeenCalled();
    expect(kpis.getState().nextDate).toBe('2026-11-19');
  });

  test('by default the drop pages no Bot; personas wait for the BNY KPI Bot fix PR', async () => {
    const run = await kpis.nextDay({ date: '2026-11-19' });
    expect(run.posts[0].investigation).toMatchObject({ paged: false, via: 'listener', botSlackId: 'U0CLC4SR91N', personas: 3 });
    expect(sendDevinSessionMessage).not.toHaveBeenCalled();
    expect(axios.post.mock.calls.filter((c) => !c[0].endsWith('chat.postMessage'))).toHaveLength(0);
    expect(axios.post.mock.calls[0][1].username).toBe('BNY KPI Bot');
    expect(inviteToChannel).toHaveBeenCalledWith('xoxb-test', 'C0CKGCDNJ2V', ['U0CLC4SR91N']);
    await jest.advanceTimersByTimeAsync(30000);
    expect(postPersonaMessage).toHaveBeenCalledTimes(0);
    getThreadReplies.mockResolvedValue([{ user: 'U0CLC4SR91N', text: "<@U0B2YAUPSHL>, can you look deeper?" }]);
    await jest.advanceTimersByTimeAsync(30000);
    expect(postPersonaMessage).toHaveBeenCalledTimes(0);
    getThreadReplies.mockResolvedValue([{ user: 'U0CLC4SR91N', text: 'Fix is up: https://github.com/COG-GTM/android-demos/pull/96' }]);
    await jest.advanceTimersByTimeAsync(5000 + 12000);
    expect(postPersonaMessage).toHaveBeenCalledTimes(3);
    postPersonaMessage.mock.calls.forEach((c) => expect(c[2]).not.toMatch(/\?/));
    expect(sendDevinSessionMessage).not.toHaveBeenCalled();
  });

  test('after a restart the next day is the day after the seed (Thu Nov 19)', () => {
    expect(kpis.getState().nextDate).toBe('2026-11-19');
  });

  test('by default clear deletes Bot thread roots without paging', async () => {
    getChannelHistory.mockResolvedValue([{ ts: '2.0', username: 'BNY KPI Bot', reply_count: 1 }]);
    getThreadReplies.mockResolvedValue([{ ts: '2.0' }, { ts: '2.2', user: 'U0CLC4SR91N' }]);
    const result = await kpis.clearChannel();
    expect(result).toMatchObject({ deleted: 1, botThreads: ['2.0'], botAsked: false });
    expect(sendDevinSessionMessage).not.toHaveBeenCalled();
  });

  test('drop day pages the Bot into the post thread and schedules personas there', async () => {
    process.env.PERSHING_KPI_PAGE_BOT = 'on';
    const run = await kpis.nextDay({ date: '2026-11-19' });
    expect(run.posts[0].investigation).toMatchObject({ paged: true, personas: 3 });
    expect(inviteToChannel).toHaveBeenCalledWith('xoxb-test', 'C0CKGCDNJ2V', ['U0CLC4SR91N']);
    const [botId, page] = sendDevinSessionMessage.mock.calls[0];
    expect(botId).toBe('bot-3a43e8d41c194bbe82bdaed7f6af36e2');
    expect(page).toContain('thread_ts 1795000000.000100');
    expect(page).toContain('metrics/screen_loads_sample.csv');
    expect(page).toContain("I've done this analysis, @Jordan Ellis, can you jump in and look deeper?");
    expect(page).toContain('HTML report');

    getThreadReplies.mockResolvedValue([{ user: 'U0CLC4SR91N', text: 'Jordan owns this flow, so the analysis below covers the confirm step.' }]);
    await jest.advanceTimersByTimeAsync(30000);
    expect(postPersonaMessage).toHaveBeenCalledTimes(0);

    getThreadReplies.mockResolvedValue([{ user: 'U0CLC4SR91N', text: 'Fix is up: https://github.com/COG-GTM/android-demos/pull/96' }]);
    await jest.advanceTimersByTimeAsync(5000);
    await jest.advanceTimersByTimeAsync(10000);
    const replies = postPersonaMessage.mock.calls;
    expect(replies.map((c) => c[3])).toEqual(['Jordan Ellis', 'Marcus Chen', 'Sofia Alvarez']);
    replies.forEach((call) => {
      expect(call[5]).toBe('1795000000.000100');
      expect(call[4]).toMatch(/^https:\/\/devindemos\.com\/bny\/avatars\/(jordan-ellis|marcus-chen|sofia-alvarez)\.png$/);
      expect(call[2]).not.toContain('<@');
    });
    expect(sendDevinSessionMessage).toHaveBeenCalledTimes(1);
  });

  test('the Bot posting its fix PR starts the personas', async () => {
    getThreadReplies.mockResolvedValue([{ user: 'U0CLC4SR91N', text: 'Fix is up: https://github.com/COG-GTM/android-demos/pull/96' }]);
    await kpis.seed();
    await kpis.nextDay();
    await jest.advanceTimersByTimeAsync(5000 + 12000);
    expect(postPersonaMessage.mock.calls.filter((c) => c[5] === '1795000000.000100').length).toBeGreaterThan(0);
  });

  test('a Bot hand-off line without a PR link does not start the personas', async () => {
    getThreadReplies.mockResolvedValue([{ user: 'U0CLC4SR91N', text: "Jordan Ellis, you own the confirm flow, so I'm handing this to you." }]);
    await kpis.nextDay({ date: '2026-11-19' });
    await jest.advanceTimersByTimeAsync(5000);
    await jest.advanceTimersByTimeAsync(10000);
    expect(postPersonaMessage).toHaveBeenCalledTimes(0);
  });

  test('personas start after the timeout when the Bot never hands off', async () => {
    getThreadReplies.mockResolvedValue([]);
    await kpis.nextDay({ date: '2026-11-19' });
    await jest.advanceTimersByTimeAsync(1515000);
    expect(postPersonaMessage).toHaveBeenCalledTimes(3);
  });

  test('pages through the Bot-owned webhook with the thread when one is configured', async () => {
    process.env.PERSHING_KPI_PAGE_BOT = 'on';
    process.env.PERSHING_KPI_BOT_WEBHOOK_URL = 'https://example.test/hook';
    process.env.BNY_IOS_BOT_WEBHOOK_SECRET = 'shh';
    const run = await kpis.nextDay({ date: '2026-11-19' });
    expect(run.posts[0].investigation).toMatchObject({ paged: true, via: 'webhook' });
    expect(sendDevinSessionMessage).not.toHaveBeenCalled();
    const [url, body, config] = axios.post.mock.calls.find((c) => c[0] === 'https://example.test/hook');
    expect(url).toBe('https://example.test/hook');
    expect(body).toMatchObject({ slack_channel_id: 'C0CKGCDNJ2V', slack_thread_ts: '1795000000.000100', bot_id: 'bot-3a43e8d41c194bbe82bdaed7f6af36e2' });
    expect(config.headers['X-Webhook-Secret']).toBe('shh');
  });

  test('stops at the end of the data instead of wrapping to the drop day', async () => {
    await kpis.nextDay({ date: '2026-11-20' });
    await expect(kpis.nextDay()).rejects.toMatchObject({ status: 409 });
    expect(kpis.getState().nextDate).toBeNull();
  });

  test('rejects an overlapping run until the current one finishes', async () => {
    let release;
    axios.post.mockImplementationOnce(() => new Promise((r) => { release = () => r({ status: 200, data: { ok: true, ts: '1795000000.000300' } }); }));
    const first = kpis.nextDay({ date: '2026-11-12' });
    await expect(kpis.nextDay({ date: '2026-11-13' })).rejects.toMatchObject({ status: 429 });
    release();
    await first;
    await expect(kpis.nextDay({ date: '2026-11-13' })).resolves.toBeTruthy();
  });

  test('clear deletes KPI posts and persona replies and asks the Bot to clean up its own', async () => {
    process.env.PERSHING_KPI_PAGE_BOT = 'on';
    getChannelHistory.mockResolvedValue([
      { ts: '1.0', username: 'KPI Bot' },
      { ts: '2.0', username: 'Pershing Access Metrics', reply_count: 3 },
      { ts: '3.0', user: 'U0B2YAUPSHL', text: 'someone else' },
    ]);
    getThreadReplies.mockResolvedValue([
      { ts: '2.0' }, { ts: '2.1', username: 'Jordan Ellis' }, { ts: '2.2', user: 'U0CLC4SR91N' }, { ts: '2.3', username: 'Sofia Alvarez' },
    ]);
    const result = await kpis.clearChannel();
    expect(result).toMatchObject({ deleted: 4, botThreads: ['2.0'], botAsked: true });
    expect(deleteMessage.mock.calls.map((c) => c[2]).sort()).toEqual(['1.0', '2.0', '2.1', '2.3']);
    expect(sendDevinSessionMessage.mock.calls[0][1]).toContain('thread_ts 2.0');
  });

  test('clear keeps Bot thread roots when the Bot cannot be asked, so a retry can find them', async () => {
    process.env.PERSHING_KPI_PAGE_BOT = 'on';
    sendDevinSessionMessage.mockResolvedValueOnce(null);
    getChannelHistory.mockResolvedValue([{ ts: '2.0', username: 'Pershing Access Metrics', reply_count: 1 }]);
    getThreadReplies.mockResolvedValue([{ ts: '2.0' }, { ts: '2.2', user: 'U0CLC4SR91N' }]);
    const result = await kpis.clearChannel();
    expect(result).toMatchObject({ deleted: 0, botAsked: false });
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  test('clear cancels persona replies still scheduled for the cleared thread', async () => {
    getThreadReplies.mockResolvedValue([{ user: 'U0CLC4SR91N', text: "I've done this analysis, @Jordan Ellis, can you jump in and look deeper?" }]);
    await kpis.nextDay({ date: '2026-11-19' });
    await jest.advanceTimersByTimeAsync(5000);
    getChannelHistory.mockResolvedValue([]);
    await kpis.clearChannel();
    await jest.advanceTimersByTimeAsync(20000);
    expect(postPersonaMessage).toHaveBeenCalledTimes(0);
  });

  test('a continuing drop day does not page the Bot again', async () => {
    await kpis.nextDay({ date: '2026-11-20' });
    expect(sendDevinSessionMessage).not.toHaveBeenCalled();
  });
});
