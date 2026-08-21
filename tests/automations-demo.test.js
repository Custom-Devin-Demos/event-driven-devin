/* global afterEach, beforeEach, describe, expect, jest, test */

jest.mock('../app/services/slack', () => ({
  archiveChannel: jest.fn(),
  createChannel: jest.fn(),
  getChannelHistory: jest.fn(),
  inviteToChannel: jest.fn(),
  postMessage: jest.fn(),
  postPersonaMessage: jest.fn(),
}));

jest.mock('axios', () => jest.fn());

describe('automations incident demo control plane', () => {
  let demo;
  let slack;
  let axios;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.SLACK_BOT_TOKEN = 'slack-token';
    process.env.AUTOMATIONS_SERVICE_BASE_URL = 'http://standing.example';
    process.env.AUTOMATIONS_DEMO_SERVICE_TOKEN = 'service-token';
    slack = require('../app/services/slack');
    axios = require('axios');
    axios.mockResolvedValue({
      data: {
        armed_at: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
        next_fire_at: new Date().toISOString(),
      },
    });
    demo = require('../app/services/automations-demo');
    demo.resetForTests();
  });

  afterEach(() => {
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.AUTOMATIONS_SERVICE_BASE_URL;
    delete process.env.AUTOMATIONS_DEMO_SERVICE_TOKEN;
    jest.useRealTimers();
  });

  test('generates a required-prefix channel name with local date and smoke suffix', () => {
    process.env.AUTOMATIONS_DEMO_TZ = 'America/Los_Angeles';
    expect(demo.baseChannelName(new Date('2026-01-02T07:00:00.000Z'))).toBe(
      'sev-1-incident-0101-scheduled-automations-failing',
    );
    expect(demo.baseChannelName(new Date('2026-01-02T07:00:00.000Z'), true)).toBe(
      'sev-1-incident-0101-scheduled-automations-failing-smoke',
    );
    delete process.env.AUTOMATIONS_DEMO_TZ;
  });

  test('retries a taken channel name while preserving the prefix', async () => {
    await demo.arm();
    slack.createChannel
      .mockRejectedValueOnce(Object.assign(new Error('Slack API error: name_taken'), { code: 'name_taken' }))
      .mockResolvedValueOnce({ id: 'C2', name: 'sev-1-incident-0102-scheduled-automations-failing-2' });
    const result = await demo.declare();
    expect(result.channel).toContain('sev-1-incident');
    expect(slack.createChannel).toHaveBeenCalledTimes(2);
    expect(slack.createChannel.mock.calls[1][1]).toMatch(/^sev-1-incident-/);
  });

  test('single-flights concurrent declares into one channel', async () => {
    await demo.arm();
    let resolveCreate;
    slack.createChannel.mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));
    const first = demo.declare();
    const second = demo.declare();
    resolveCreate({ id: 'C1', name: 'sev-1-incident-0102-scheduled-automations-failing' });
    const [a, b] = await Promise.all([first, second]);
    expect(slack.createChannel).toHaveBeenCalledTimes(1);
    expect(a.channel).toBe(b.channel);
    expect(b.alreadyActive).toBe(true);
  });

  test('status explains an unreachable standing instance', async () => {
    axios.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const status = await demo.getStatus();
    expect(status.standing_instance.reachable).toBe(false);
    expect(status.error).toMatch(/standing instance unreachable/);
    expect(status.errors_since_arm).toBeNull();
  });

  test('drips persona chatter in order and stop cancels the remaining timers', async () => {
    jest.useFakeTimers();
    await demo.arm();
    slack.createChannel.mockResolvedValue({
      id: 'C1',
      name: 'sev-1-incident-0102-scheduled-automations-failing',
    });
    await demo.declare();
    jest.advanceTimersByTime(30 * 1000);
    await Promise.resolve();
    jest.advanceTimersByTime(30 * 1000);
    await Promise.resolve();
    expect(slack.postPersonaMessage.mock.calls.map((call) => call[2])).toEqual([
      'sorry to the platform team you all got added, we don\'t have a team on automations',
      'did we ship anything yesterday? I don\'t see a deploy',
    ]);
    await demo.stop();
    jest.advanceTimersByTime(5 * 60 * 1000);
    expect(slack.postPersonaMessage).toHaveBeenCalledTimes(2);
  });

  test('cleanup is idempotent', async () => {
    await demo.arm();
    slack.createChannel.mockResolvedValue({
      id: 'C1',
      name: 'sev-1-incident-0102-scheduled-automations-failing',
    });
    await demo.declare();
    await demo.stop();
    await demo.stop();
    expect(slack.postMessage).toHaveBeenCalledTimes(2);
    expect(axios).toHaveBeenCalledTimes(2);
  });
});
