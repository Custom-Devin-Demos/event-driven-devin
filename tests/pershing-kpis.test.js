jest.mock('../app/services/slack', () => ({
  postPersonaMessage: jest.fn(() => Promise.resolve('1795000000.000100')),
  inviteToChannel: jest.fn(() => Promise.resolve(true)),
  joinChannel: jest.fn(() => Promise.resolve(true)),
  getThreadReplies: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../app/services/devin-api', () => ({
  sendDevinSessionMessage: jest.fn(() => Promise.resolve({ sessionId: 'bot-59656379ddc5470281166b1458334c2c', url: 'https://app.devin.ai/bots/x' })),
}));

jest.mock('axios', () => ({ post: jest.fn(() => Promise.resolve({ status: 200 })) }));

const axios = require('axios');
const { postPersonaMessage, inviteToChannel, getThreadReplies } = require('../app/services/slack');
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
  });
  afterEach(() => jest.useRealTimers());

  test('labels each post with its date and day-over-day deltas', () => {
    const { text, analysis } = kpis.renderDay('2026-11-12');
    expect(text).toContain('Thu, Nov 12, 2026');
    expect(text).toMatch(/DoD/);
    expect(analysis.isDrop).toBe(false);
  });

  test('flags Nov 16 as a new Android completion drop and later days as continuing', () => {
    const drop = kpis.analyzeDay('2026-11-16');
    expect(drop.isNewDrop).toBe(true);
    expect(drop.dropPts).toBeCloseTo(6.3, 1);
    expect(kpis.renderDay('2026-11-16').text).toContain('Android transfer completion is 6.3 pts below');
    expect(kpis.analyzeDay('2026-11-17').isDrop).toBe(true);
    expect(kpis.analyzeDay('2026-11-17').isNewDrop).toBe(false);
  });

  test('seed posts Nov 9-15 without paging the Bot', async () => {
    const run = await kpis.seed();
    expect(run.posts.map((p) => p.date)).toEqual(['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15']);
    expect(postPersonaMessage).toHaveBeenCalledTimes(7);
    expect(sendDevinSessionMessage).not.toHaveBeenCalled();
    expect(kpis.getState().nextDate).toBe('2026-11-16');
  });

  test('drop day pages the Bot into the post thread and schedules personas there', async () => {
    const run = await kpis.nextDay({ date: '2026-11-16' });
    expect(run.posts[0].investigation).toMatchObject({ paged: true, personas: 3 });
    expect(inviteToChannel).toHaveBeenCalledWith('xoxb-test', 'C0CKGCDNJ2V', ['U0CK6TNG7T3']);
    const [botId, page] = sendDevinSessionMessage.mock.calls[0];
    expect(botId).toBe('bot-59656379ddc5470281166b1458334c2c');
    expect(page).toContain('thread_ts 1795000000.000100');
    expect(page).toContain('metrics/events_sample.csv');
    expect(page).toContain('@Jordan Ellis, can you jump in and look deeper?');
    expect(page).toContain('HTML report');

    getThreadReplies.mockResolvedValue([{ user: 'U0CK6TNG7T3', text: 'Jordan owns this flow, so the analysis below covers the confirm step.' }]);
    await jest.advanceTimersByTimeAsync(30000);
    expect(postPersonaMessage).toHaveBeenCalledTimes(1);

    getThreadReplies.mockResolvedValue([{ user: 'U0CK6TNG7T3', text: "I've done this analysis, @Jordan Ellis, can you jump in and look deeper?" }]);
    await jest.advanceTimersByTimeAsync(5000);
    await jest.advanceTimersByTimeAsync(10000);
    const replies = postPersonaMessage.mock.calls.slice(1);
    expect(replies.map((c) => c[3])).toEqual(['Jordan Ellis', 'Marcus Chen', 'Sofia Alvarez']);
    replies.forEach((call) => {
      expect(call[5]).toBe('1795000000.000100');
      expect(call[4]).toMatch(/^https:\/\/devindemos\.com\/bny\/avatars\/(jordan-ellis|marcus-chen|sofia-alvarez)\.png$/);
      expect(call[2]).not.toContain('<@');
    });
    expect(sendDevinSessionMessage).toHaveBeenCalledTimes(3);
    expect(sendDevinSessionMessage.mock.calls[1][1]).toContain('Jordan Ellis');
  });

  test('personas start after the timeout when the Bot never hands off', async () => {
    getThreadReplies.mockResolvedValue([]);
    await kpis.nextDay({ date: '2026-11-16' });
    await jest.advanceTimersByTimeAsync(615000);
    expect(postPersonaMessage).toHaveBeenCalledTimes(4);
  });

  test('pages through the Bot-owned webhook with the thread when one is configured', async () => {
    process.env.PERSHING_KPI_BOT_WEBHOOK_URL = 'https://example.test/hook';
    process.env.BNY_IOS_BOT_WEBHOOK_SECRET = 'shh';
    const run = await kpis.nextDay({ date: '2026-11-16' });
    expect(run.posts[0].investigation).toMatchObject({ paged: true, via: 'webhook' });
    expect(sendDevinSessionMessage).not.toHaveBeenCalled();
    const [url, body, config] = axios.post.mock.calls[0];
    expect(url).toBe('https://example.test/hook');
    expect(body).toMatchObject({ slack_channel_id: 'C0CKGCDNJ2V', slack_thread_ts: '1795000000.000100', bot_id: 'bot-59656379ddc5470281166b1458334c2c' });
    expect(config.headers['X-Webhook-Secret']).toBe('shh');
  });

  test('stops at the end of the data instead of wrapping to the drop day', async () => {
    await kpis.nextDay({ date: '2026-11-20' });
    await expect(kpis.nextDay()).rejects.toMatchObject({ status: 409 });
    expect(kpis.getState().nextDate).toBeNull();
  });

  test('rejects an overlapping run until the current one finishes', async () => {
    let release;
    postPersonaMessage.mockImplementationOnce(() => new Promise((r) => { release = () => r('1795000000.000300'); }));
    const first = kpis.nextDay({ date: '2026-11-12' });
    await expect(kpis.nextDay({ date: '2026-11-13' })).rejects.toMatchObject({ status: 429 });
    release();
    await first;
    await expect(kpis.nextDay({ date: '2026-11-13' })).resolves.toBeTruthy();
  });

  test('a continuing drop day does not page the Bot again', async () => {
    await kpis.nextDay({ date: '2026-11-17' });
    expect(sendDevinSessionMessage).not.toHaveBeenCalled();
  });
});
