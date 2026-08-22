/* global afterEach, beforeEach, describe, expect, jest, test */

const http = require('http');

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
    delete process.env.AUTOMATIONS_DEMO_TOKEN;
    delete process.env.DEVIN_SLACK_USER_ID;
    delete process.env.AUTOMATIONS_DEMO_TZ;
    delete process.env.AUTOMATIONS_STANDING_REPO_URL;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
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

  test('failed declaration post leaves a clean state for retry', async () => {
    await demo.arm();
    slack.createChannel
      .mockResolvedValueOnce({ id: 'C1', name: 'sev-1-incident-first' })
      .mockResolvedValueOnce({ id: 'C2', name: 'sev-1-incident-second' });
    slack.postMessage.mockRejectedValueOnce(new Error('declaration post failed'));
    await expect(demo.declare()).rejects.toThrow('declaration post failed');
    const result = await demo.declare();
    expect(slack.createChannel).toHaveBeenCalledTimes(2);
    expect(result.channel).toBe('sev-1-incident-second');
    expect(result.alreadyActive).toBe(false);
  });

  test('rejects arming while an incident run is active', async () => {
    await demo.arm();
    slack.createChannel.mockResolvedValue({ id: 'C1', name: 'sev-1-incident-active' });
    await demo.declare();
    await expect(demo.arm()).rejects.toMatchObject({ statusCode: 400 });
    expect(axios).toHaveBeenCalledTimes(1);
  });

  test('rejects near-term schedules and preserves the T-45m arm schedule', () => {
    expect(() => demo.schedule(new Date(Date.now() + 29 * 60 * 1000).toISOString()))
      .toThrow('at least 30 minutes');
    const declareAt = new Date(Date.now() + 60 * 60 * 1000);
    const result = demo.schedule(declareAt.toISOString());
    expect(result.scheduledArmAt).toBe(new Date(declareAt.getTime() - 45 * 60 * 1000).toISOString());
  });

  test('archives a channel when declaration posting fails', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    await demo.arm();
    slack.createChannel.mockResolvedValue({ id: 'C1', name: 'sev-1-incident-orphaned' });
    slack.postMessage.mockRejectedValueOnce(new Error('declaration post failed'));
    await expect(demo.declare()).rejects.toThrow('declaration post failed');
    jest.setSystemTime(new Date('2026-01-02T01:00:00.000Z'));
    expect((await demo.archiveStale()).archived).toBe(1);
    expect(slack.archiveChannel).toHaveBeenCalledWith('slack-token', 'C1');
  });

  test('rejects declaring after the previous run has stopped', async () => {
    await demo.arm();
    slack.createChannel.mockResolvedValue({ id: 'C1', name: 'sev-1-incident-stopped' });
    await demo.declare();
    await demo.stop();
    await expect(demo.declare()).rejects.toMatchObject({ statusCode: 400 });
    expect(slack.createChannel).toHaveBeenCalledTimes(1);
  });

  test('rejects declaring while stop is in flight', async () => {
    await demo.arm();
    slack.createChannel.mockResolvedValue({ id: 'C1', name: 'sev-1-incident-stopping' });
    await demo.declare();
    let resolveWrap;
    slack.postMessage.mockImplementationOnce(() => new Promise((resolve) => {
      resolveWrap = resolve;
    }));
    const stopping = demo.stop();
    await expect(demo.declare()).rejects.toMatchObject({
      statusCode: 400,
      message: 'Cannot declare while the incident is stopping',
    });
    resolveWrap();
    await stopping;
  });

  test('clears scheduled fields when stop cancels a pending declaration', async () => {
    const declareAt = new Date(Date.now() + 60 * 60 * 1000);
    demo.schedule(declareAt.toISOString());
    await demo.stop();
    const status = await demo.getStatus();
    expect(status.scheduled_declare_at).toBeNull();
    expect(status.scheduled_arm_at).toBeNull();
  });

  test('keeps future scheduled fields when the auto-arm fires', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const declareAt = new Date(Date.now() + 60 * 60 * 1000);
    demo.schedule(declareAt.toISOString());
    jest.advanceTimersByTime(15 * 60 * 1000);
    await Promise.resolve();
    const status = await demo.getStatus();
    expect(status.scheduled_declare_at).toBe(declareAt.toISOString());
    expect(status.scheduled_arm_at).toBe(new Date(declareAt.getTime() - 45 * 60 * 1000).toISOString());
  });

  test('clears scheduled fields when the scheduled declaration is stale', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const declareAt = new Date(Date.now() + 60 * 60 * 1000);
    demo.schedule(declareAt.toISOString());
    jest.setSystemTime(new Date(declareAt.getTime() + 1));
    await demo.arm();
    const status = await demo.getStatus();
    expect(status.scheduled_declare_at).toBeNull();
    expect(status.scheduled_arm_at).toBeNull();
  });

  test('uses the configured standing repo URL for PR cleanup', async () => {
    process.env.GITHUB_TOKEN = 'github-token';
    process.env.AUTOMATIONS_STANDING_REPO_URL = 'https://github.com/example/demo-service.git';
    axios.get = jest.fn().mockResolvedValue({
      data: [{ number: 12, head: { ref: 'devin/fix' } }],
    });
    axios.patch = jest.fn().mockResolvedValue({});
    await demo.arm();
    slack.createChannel.mockResolvedValue({ id: 'C1', name: 'sev-1-incident-repo' });
    await demo.declare();
    await demo.stop();
    expect(axios.get).toHaveBeenCalledWith(
      'https://api.github.com/repos/example/demo-service/pulls',
      expect.any(Object),
    );
    expect(axios.patch).toHaveBeenCalledWith(
      'https://api.github.com/repos/example/demo-service/pulls/12',
      { state: 'closed' },
      expect.any(Object),
    );
  });

  test('skips PR cleanup when the configured standing repo URL is invalid', async () => {
    process.env.GITHUB_TOKEN = 'github-token';
    process.env.AUTOMATIONS_STANDING_REPO_URL = 'not-a-repo-url';
    axios.get = jest.fn();
    await demo.arm();
    slack.createChannel.mockResolvedValue({ id: 'C1', name: 'sev-1-incident-invalid-repo' });
    await demo.declare();
    await demo.stop();
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('stop during declaration waits and cancels all timers', async () => {
    jest.useFakeTimers();
    await demo.arm();
    let resolvePost;
    slack.createChannel.mockResolvedValue({ id: 'C1', name: 'sev-1-incident-in-flight' });
    slack.postMessage.mockReturnValueOnce(new Promise((resolve) => { resolvePost = resolve; }));
    const declaring = demo.declare();
    await Promise.resolve();
    await Promise.resolve();
    const stopping = demo.stop();
    resolvePost();
    await Promise.all([declaring, stopping]);
    jest.advanceTimersByTime(60 * 60 * 1000);
    await Promise.resolve();
    expect(slack.postPersonaMessage).not.toHaveBeenCalled();
    expect(slack.postMessage).toHaveBeenCalledTimes(2);
  });

  test('rejects mutation requests when the demo token is unconfigured', async () => {
    delete process.env.AUTOMATIONS_DEMO_TOKEN;
    const express = require('express');
    const router = require('../app/routes/automations-demo');
    const app = express();
    app.use(express.json());
    app.use(router);
    const server = await new Promise((resolve) => {
      const listener = app.listen(0, () => resolve(listener));
    });
    try {
      const response = await new Promise((resolve, reject) => {
        const request = http.request({
          port: server.address().port,
          method: 'POST',
          path: '/api/automations-demo/arm',
        }, (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => resolve({ statusCode: res.statusCode, body: JSON.parse(body) }));
        });
        request.on('error', reject);
        request.end();
      });
      expect(response.statusCode).toBe(503);
      expect(response.body.ok).toBe(false);
      expect(response.body.error).toMatch(/AUTOMATIONS_DEMO_TOKEN is not configured/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('arm clears the previous run channel and stale fields', async () => {
    await demo.arm();
    slack.createChannel.mockResolvedValue({
      id: 'C1',
      name: 'sev-1-incident-previous',
    });
    await demo.declare();
    await demo.stop();
    await demo.arm();
    const status = await demo.getStatus();
    expect(status.runState).toBe('armed');
    expect(status.channel).toBeNull();
    expect(status.declared_at).toBeNull();
    expect(status.chatter_posted).toBe(0);
    expect(status.scheduled_declare_at).toBeNull();
    expect(status.scheduled_arm_at).toBeNull();
  });

  test('adopts standing armed_at after local state reset', async () => {
    axios.mockResolvedValueOnce({
      data: {
        armed: true,
        armed_at: '2026-01-01T12:00:00.000Z',
        errors_since_arm: 17,
        dlq_depth: 17,
        emitter_heartbeat_age_s: 2,
      },
    });
    slack.createChannel.mockResolvedValue({
      id: 'C1',
      name: 'sev-1-incident-recovered',
    });
    const result = await demo.declare();
    expect(result.channel).toBe('sev-1-incident-recovered');
    const status = await demo.getStatus();
    expect(status.armed_at).toBe('2026-01-01T12:00:00.000Z');
  });

  test('status explains an unreachable standing instance', async () => {
    axios.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const status = await demo.getStatus();
    expect(status.ok).toBe(true);
    expect(status.standing_instance.reachable).toBe(false);
    expect(status.standing_instance.error).toMatch(/standing instance unreachable/);
    expect(status.errors_since_arm).toBeNull();
  });

  test('smoke polls Slack history from the declared message timestamp and Devin author', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-02T07:00:00.000Z'));
    process.env.DEVIN_SLACK_USER_ID = 'UDEVIN';
    slack.createChannel.mockResolvedValue({
      id: 'C1',
      name: 'sev-1-incident-0102-scheduled-automations-failing-smoke',
    });
    slack.getChannelHistory.mockResolvedValue([
      { user: 'UDEVIN', text: 'Root cause identified' },
    ]);
    await demo.smoke();
    expect(slack.getChannelHistory).toHaveBeenCalledWith(
      'slack-token',
      'C1',
      { limit: 100, oldest: 1767337200 },
    );
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
