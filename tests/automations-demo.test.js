/* global afterEach, beforeEach, describe, expect, jest, test */

const http = require('http');

jest.mock('../app/services/slack', () => ({
  findChannelByNameFragment: jest.fn(),
  getChannelHistory: jest.fn(),
  inviteToChannel: jest.fn(),
  joinChannel: jest.fn(),
  postMessage: jest.fn(),
  postPersonaMessage: jest.fn(),
}));

jest.mock('../app/services/datadog-incidents', () => ({
  declareDatadogIncident: jest.fn(),
  resolveDatadogIncident: jest.fn(),
}));

jest.mock('axios', () => jest.fn());

const CHANNEL = { id: 'C1', name: 'sev-1-incident-42-scheduled-automations-failing' };

describe('automations incident demo control plane', () => {
  let demo;
  let slack;
  let dd;
  let axios;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.SLACK_BOT_TOKEN = 'slack-token';
    process.env.AUTOMATIONS_DEMO_SERVICE_BASE_URL = 'http://standing.example';
    process.env.AUTOMATIONS_DEMO_SERVICE_TOKEN = 'service-token';
    process.env.AUTOMATIONS_DEMO_SMOKE_ACCUMULATION_WAIT_MS = '0';
    slack = require('../app/services/slack');
    dd = require('../app/services/datadog-incidents');
    axios = require('axios');
    axios.mockResolvedValue({
      data: {
        armed_at: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
        next_fire_at: new Date().toISOString(),
      },
    });
    dd.declareDatadogIncident.mockResolvedValue({ id: 'inc-1', publicId: 42 });
    dd.resolveDatadogIncident.mockResolvedValue(true);
    slack.findChannelByNameFragment.mockResolvedValue(null);
    demo = require('../app/services/automations-demo');
    demo.resetForTests();
  });

  afterEach(() => {
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_ONCALL_BOT_TOKEN;
    delete process.env.AUTOMATIONS_DEMO_SERVICE_BASE_URL;
    delete process.env.AUTOMATIONS_DEMO_SERVICE_TOKEN;
    delete process.env.AUTOMATIONS_DEMO_SMOKE_ACCUMULATION_WAIT_MS;
    delete process.env.AUTOMATIONS_DEMO_TOKEN;
    delete process.env.DEVIN_SLACK_USER_ID;
    delete process.env.AUTOMATIONS_DEMO_STANDING_REPO_URL;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    jest.useRealTimers();
  });

  async function discoverChannel(channel = CHANNEL) {
    slack.findChannelByNameFragment.mockResolvedValue(channel);
    await jest.advanceTimersByTimeAsync(15000);
  }

  test('declare creates a Datadog incident and returns before the channel exists', async () => {
    await demo.arm();
    const result = await demo.declare();
    expect(dd.declareDatadogIncident).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Scheduled automations failing',
      runRef: expect.stringMatching(/^run-[0-9a-f]{12}$/),
    }));
    expect(result.publicId).toBe(42);
    expect(result.channel).toBeNull();
    const status = await demo.getStatus();
    expect(status.runState).toBe('declared');
    expect(status.incident_public_id).toBe(42);
    expect(status.channel).toBeNull();
  });

  test('discovers the Datadog-created channel, joins, posts the card, and invites Devin', async () => {
    jest.useFakeTimers();
    process.env.DEVIN_SLACK_USER_ID = 'UDEVIN';
    await demo.arm();
    await demo.declare();
    await discoverChannel();
    expect(slack.findChannelByNameFragment).toHaveBeenCalledWith('slack-token', 'incident-42-');
    expect(slack.joinChannel).toHaveBeenCalledWith('slack-token', 'C1');
    expect(slack.postMessage).toHaveBeenCalledWith('slack-token', 'C1', expect.any(String), expect.any(Array));
    expect(slack.inviteToChannel).toHaveBeenCalledWith('slack-token', 'C1', ['UDEVIN']);
    const status = await demo.getStatus();
    expect(status.channel.name).toBe(CHANNEL.name);
  });

  test('prefers the oncall bot token for all Slack calls', async () => {
    jest.useFakeTimers();
    process.env.SLACK_ONCALL_BOT_TOKEN = 'oncall-token';
    await demo.arm();
    await demo.declare();
    await discoverChannel();
    expect(slack.findChannelByNameFragment).toHaveBeenCalledWith('oncall-token', 'incident-42-');
    expect(slack.joinChannel).toHaveBeenCalledWith('oncall-token', 'C1');
  });

  test('keeps polling until the channel appears and gives up after the attempt cap', async () => {
    jest.useFakeTimers();
    await demo.arm();
    await demo.declare();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await jest.advanceTimersByTimeAsync(15000);
    }
    expect(slack.findChannelByNameFragment).toHaveBeenCalledTimes(40);
    await jest.advanceTimersByTimeAsync(60000);
    expect(slack.findChannelByNameFragment).toHaveBeenCalledTimes(40);
    expect(slack.postMessage).not.toHaveBeenCalled();
  });

  test('retries discovery when joining the found channel fails', async () => {
    jest.useFakeTimers();
    await demo.arm();
    await demo.declare();
    slack.findChannelByNameFragment.mockResolvedValue(CHANNEL);
    slack.joinChannel.mockRejectedValueOnce(new Error('slack hiccup'));
    await jest.advanceTimersByTimeAsync(15000);
    expect(slack.joinChannel).toHaveBeenCalledTimes(1);
    expect(slack.postMessage).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(15000);
    expect(slack.joinChannel).toHaveBeenCalledTimes(2);
    expect(slack.postMessage).toHaveBeenCalledWith('slack-token', 'C1', expect.any(String), expect.any(Array));
  });

  test('stops retrying joins on a permanent Slack error', async () => {
    jest.useFakeTimers();
    await demo.arm();
    await demo.declare();
    slack.findChannelByNameFragment.mockResolvedValue(CHANNEL);
    slack.joinChannel.mockRejectedValue(new Error('Slack API error: missing_scope'));
    await jest.advanceTimersByTimeAsync(15000);
    expect(slack.joinChannel).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(60000);
    expect(slack.joinChannel).toHaveBeenCalledTimes(1);
    expect(slack.postMessage).not.toHaveBeenCalled();
  });

  test('single-flights concurrent declares into one incident', async () => {
    await demo.arm();
    let resolveDeclare;
    dd.declareDatadogIncident.mockReturnValue(new Promise((resolve) => { resolveDeclare = resolve; }));
    const first = demo.declare();
    const second = demo.declare();
    resolveDeclare({ id: 'inc-1', publicId: 42 });
    const [a, b] = await Promise.all([first, second]);
    expect(dd.declareDatadogIncident).toHaveBeenCalledTimes(1);
    expect(a.publicId).toBe(b.publicId);
    expect(b.alreadyActive).toBe(true);
  });

  test('failed Datadog declaration leaves a clean state for retry', async () => {
    await demo.arm();
    dd.declareDatadogIncident.mockRejectedValueOnce(new Error('datadog declaration failed'));
    await expect(demo.declare()).rejects.toThrow('datadog declaration failed');
    expect((await demo.getStatus()).runState).toBe('armed');
    const result = await demo.declare();
    expect(result.publicId).toBe(42);
    expect(result.alreadyActive).toBe(false);
  });

  test('unconfigured Datadog keys fail the declaration with a clear error', async () => {
    await demo.arm();
    dd.declareDatadogIncident.mockResolvedValueOnce(null);
    await expect(demo.declare()).rejects.toMatchObject({
      statusCode: 503,
      message: expect.stringMatching(/DD_API_KEY/),
    });
    expect((await demo.getStatus()).runState).toBe('armed');
  });

  test('failed declaration preserves a pending scheduled run', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const declareAt = new Date(Date.now() + 60 * 60 * 1000);
    axios.mockResolvedValue({
      data: {
        armed: true,
        armed_at: new Date(Date.now()).toISOString(),
        next_fire_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        errors_since_arm: 1,
        dlq_depth: 1,
        emitter_heartbeat_age_s: 2,
      },
    });
    demo.schedule(declareAt.toISOString());
    await demo.arm();
    dd.declareDatadogIncident.mockRejectedValueOnce(new Error('datadog declaration failed'));
    await expect(demo.declare()).rejects.toThrow('datadog declaration failed');
    let status = await demo.getStatus();
    expect(status.scheduled_declare_at).toBe(declareAt.toISOString());
    expect(status.scheduled_arm_at).toBe(
      new Date(declareAt.getTime() - 45 * 60 * 1000).toISOString(),
    );
    await jest.advanceTimersByTimeAsync(45 * 60 * 1000);
    await jest.advanceTimersByTimeAsync(15 * 60 * 1000);
    status = await demo.getStatus();
    expect(status.runState).toBe('declared');
    expect(status.scheduled_declare_at).toBeNull();
    expect(status.scheduled_arm_at).toBeNull();
  });

  test('rejects arming while an incident run is active', async () => {
    await demo.arm();
    await demo.declare();
    await expect(demo.arm()).rejects.toMatchObject({ statusCode: 400 });
    expect(axios).toHaveBeenCalledTimes(1);
  });

  test('rejects arming while declaration is in flight', async () => {
    await demo.arm();
    let resolveDeclare;
    dd.declareDatadogIncident.mockReturnValueOnce(new Promise((resolve) => {
      resolveDeclare = resolve;
    }));
    const declaring = demo.declare();
    await Promise.resolve();
    await Promise.resolve();
    await expect(demo.arm()).rejects.toMatchObject({ statusCode: 400 });
    expect(axios).toHaveBeenCalledTimes(1);
    resolveDeclare({ id: 'inc-1', publicId: 42 });
    await declaring;
  });

  test('rejects arming while stop is in flight', async () => {
    await demo.arm();
    await demo.declare();
    let resolveDisarm;
    axios.mockImplementationOnce(() => new Promise((resolve) => {
      resolveDisarm = resolve;
    }));
    const stopping = demo.stop();
    await Promise.resolve();
    await expect(demo.arm()).rejects.toMatchObject({ statusCode: 400 });
    resolveDisarm({ data: {} });
    await stopping;
  });

  test('rejects near-term schedules and preserves the T-45m arm schedule', () => {
    expect(() => demo.schedule(new Date(Date.now() + 29 * 60 * 1000).toISOString()))
      .toThrow('at least 30 minutes');
    const declareAt = new Date(Date.now() + 60 * 60 * 1000);
    const result = demo.schedule(declareAt.toISOString());
    expect(result.scheduledArmAt).toBe(new Date(declareAt.getTime() - 45 * 60 * 1000).toISOString());
  });

  test('scheduled declare requires errors to be flowing', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const declareAt = new Date(Date.now() + 30 * 60 * 1000);
    demo.schedule(declareAt.toISOString());
    jest.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(30 * 60 * 1000);
    await Promise.resolve();
    await Promise.resolve();
    expect(dd.declareDatadogIncident).not.toHaveBeenCalled();
    const status = await demo.getStatus();
    expect(status.runState).toBe('armed');
    expect(status.scheduled_declare_at).toBeNull();
    expect(status.scheduled_arm_at).toBeNull();
  });

  test('rejects declaring after the previous run has stopped', async () => {
    await demo.arm();
    await demo.declare();
    await demo.stop();
    await expect(demo.declare()).rejects.toMatchObject({ statusCode: 400 });
    expect(dd.declareDatadogIncident).toHaveBeenCalledTimes(1);
  });

  test('rejects declaring while stop is in flight', async () => {
    await demo.arm();
    await demo.declare();
    let resolveDisarm;
    axios.mockImplementationOnce(() => new Promise((resolve) => {
      resolveDisarm = resolve;
    }));
    const stopping = demo.stop();
    await expect(demo.declare()).rejects.toMatchObject({
      statusCode: 400,
      message: 'Cannot declare while the incident is stopping',
    });
    resolveDisarm({ data: {} });
    await stopping;
  });

  test('stop resolves the Datadog incident', async () => {
    await demo.arm();
    await demo.declare();
    await demo.stop();
    expect(dd.resolveDatadogIncident).toHaveBeenCalledWith('inc-1');
    const status = await demo.getStatus();
    expect(status.runState).toBe('stopped');
    expect(status.incident_public_id).toBeNull();
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
    process.env.AUTOMATIONS_DEMO_STANDING_REPO_URL = 'https://github.com/example/demo-service.git';
    axios.get = jest.fn().mockResolvedValue({
      data: [{ number: 12, head: { ref: 'devin/fix' } }],
    });
    axios.patch = jest.fn().mockResolvedValue({});
    await demo.arm();
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
    process.env.AUTOMATIONS_DEMO_STANDING_REPO_URL = 'not-a-repo-url';
    axios.get = jest.fn();
    await demo.arm();
    await demo.declare();
    await demo.stop();
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('stop during declaration waits and cancels channel discovery', async () => {
    jest.useFakeTimers();
    await demo.arm();
    let resolveDeclare;
    dd.declareDatadogIncident.mockReturnValueOnce(new Promise((resolve) => { resolveDeclare = resolve; }));
    const declaring = demo.declare();
    await Promise.resolve();
    await Promise.resolve();
    const stopping = demo.stop();
    resolveDeclare({ id: 'inc-1', publicId: 42 });
    await Promise.all([declaring, stopping]);
    slack.findChannelByNameFragment.mockResolvedValue(CHANNEL);
    await jest.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(slack.postMessage).not.toHaveBeenCalled();
    expect(slack.postPersonaMessage).not.toHaveBeenCalled();
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

  test('failed mutation does not consume the hourly cap', async () => {
    process.env.AUTOMATIONS_DEMO_TOKEN = 'demo-token';
    const express = require('express');
    const router = require('../app/routes/automations-demo');
    const app = express();
    app.use(express.json());
    app.use(router);
    const server = await new Promise((resolve) => {
      const listener = app.listen(0, () => resolve(listener));
    });
    const postArm = () => new Promise((resolve, reject) => {
      const request = http.request({
        port: server.address().port,
        method: 'POST',
        path: '/api/automations-demo/arm',
        headers: { 'x-automations-demo-token': 'demo-token' },
      }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      request.on('error', reject);
      request.end();
    });
    try {
      axios.mockRejectedValueOnce(new Error('standing instance unavailable'));
      expect(await postArm()).toBe(502);
      axios.mockResolvedValue({
        data: {
          armed_at: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
          next_fire_at: new Date().toISOString(),
        },
      });
      for (let attempt = 0; attempt < 10; attempt += 1) {
        expect(await postArm()).toBe(200);
      }
      expect(await postArm()).toBe(429);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('arm clears the previous run channel and stale fields', async () => {
    await demo.arm();
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
    const result = await demo.declare();
    expect(result.publicId).toBe(42);
    const status = await demo.getStatus();
    expect(status.armed_at).toBe('2026-01-01T12:00:00.000Z');
  });

  test('does not re-adopt standing arm state while stop is in flight', async () => {
    await demo.arm();
    let resolveStatus;
    let resolveDisarm;
    let firstStatus = true;
    axios.mockImplementation((config) => {
      if (config.method === 'get' && config.url.endsWith('/admin/demo/status') && firstStatus) {
        firstStatus = false;
        return new Promise((resolve) => {
          resolveStatus = resolve;
        });
      }
      if (config.method === 'post' && config.url.endsWith('/admin/demo/disarm')) {
        return new Promise((resolve) => {
          resolveDisarm = resolve;
        });
      }
      return Promise.resolve({
        data: {
          armed: true,
          armed_at: '2026-01-01T12:00:00.000Z',
          errors_since_arm: 17,
          dlq_depth: 17,
          emitter_heartbeat_age_s: 2,
        },
      });
    });
    const polling = demo.getStatus();
    await Promise.resolve();
    const stopping = demo.stop();
    await Promise.resolve();
    resolveStatus({
      data: {
        armed: true,
        armed_at: '2026-01-01T12:00:00.000Z',
        errors_since_arm: 17,
        dlq_depth: 17,
        emitter_heartbeat_age_s: 2,
      },
    });
    await Promise.resolve();
    resolveDisarm({ data: { disarmed_at: '2026-01-01T12:00:00.000Z' } });
    await Promise.all([polling, stopping]);
    const status = await demo.getStatus();
    expect(status.runState).toBe('stopped');
    expect(status.armed_at).toBeNull();
  });

  test('status explains an unreachable standing instance', async () => {
    axios.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const status = await demo.getStatus();
    expect(status.ok).toBe(true);
    expect(status.standing_instance.reachable).toBe(false);
    expect(status.standing_instance.error).toMatch(/standing instance unreachable/);
    expect(status.errors_since_arm).toBeNull();
  });

  test('smoke waits for channel discovery and polls history from the declared timestamp', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-02T07:00:00.000Z'));
    process.env.DEVIN_SLACK_USER_ID = 'UDEVIN';
    slack.getChannelHistory.mockResolvedValue([
      { user: 'UDEVIN', text: 'Root cause identified' },
    ]);
    const smokeRun = demo.smoke();
    await Promise.resolve();
    await Promise.resolve();
    await discoverChannel();
    await jest.advanceTimersByTimeAsync(30 * 1000);
    await expect(smokeRun).resolves.toMatchObject({ ok: true, success: true });
    expect(slack.getChannelHistory).toHaveBeenCalledWith(
      'slack-token',
      'C1',
      { limit: 100, oldest: 1767337200 },
    );
  });

  test('smoke refuses while a presenter run is armed', async () => {
    await demo.arm();
    await expect(demo.smoke()).rejects.toMatchObject({
      statusCode: 400,
      message: 'Cannot run smoke while a presenter demo is in progress',
    });
    expect(axios).toHaveBeenCalledTimes(1);
    expect(dd.declareDatadogIncident).not.toHaveBeenCalled();
  });

  test('smoke refuses while a presenter run is declared without cleanup', async () => {
    await demo.arm();
    await demo.declare();
    await expect(demo.smoke()).rejects.toMatchObject({ statusCode: 400 });
    expect(dd.declareDatadogIncident).toHaveBeenCalledTimes(1);
    expect(dd.resolveDatadogIncident).not.toHaveBeenCalled();
    expect(axios.mock.calls.some(([config]) => config.url.endsWith('/admin/demo/disarm'))).toBe(false);
    const status = await demo.getStatus();
    expect(status.runState).toBe('declared');
    expect(status.smoke_in_progress).toBe(false);
  });

  test('smoke ownership blocks presenter declaration during accumulation and releases after cleanup', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    process.env.AUTOMATIONS_DEMO_SMOKE_ACCUMULATION_WAIT_MS = String(30 * 60 * 1000);
    process.env.DEVIN_SLACK_USER_ID = 'UDEVIN';
    axios.mockResolvedValue({
      data: {
        armed: true,
        armed_at: new Date(Date.now()).toISOString(),
        next_fire_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        errors_since_arm: 1,
        dlq_depth: 1,
        emitter_heartbeat_age_s: 2,
      },
    });
    slack.getChannelHistory.mockResolvedValue([
      { user: 'UDEVIN', text: 'Root cause: scheduled failures' },
    ]);
    const smokeRun = demo.smoke();
    await Promise.resolve();
    await Promise.resolve();
    await expect(demo.declare()).rejects.toMatchObject({
      statusCode: 400,
      message: 'Cannot declare while a smoke run is in progress',
    });
    expect((await demo.getStatus()).smoke_in_progress).toBe(true);
    await jest.advanceTimersByTimeAsync(30 * 60 * 1000);
    slack.findChannelByNameFragment.mockResolvedValue(CHANNEL);
    await jest.advanceTimersByTimeAsync(60 * 1000);
    await expect(smokeRun).resolves.toMatchObject({ ok: true, success: true });
    expect((await demo.getStatus()).smoke_in_progress).toBe(false);
    expect(axios.mock.calls.some(([config]) => config.url.endsWith('/admin/demo/disarm'))).toBe(true);
  });

  test('smoke refuses while a future presenter schedule is pending', async () => {
    const declareAt = new Date(Date.now() + 60 * 60 * 1000);
    demo.schedule(declareAt.toISOString());
    await expect(demo.smoke()).rejects.toMatchObject({ statusCode: 400 });
    const status = await demo.getStatus();
    expect(status.scheduled_declare_at).toBe(declareAt.toISOString());
    expect(status.scheduled_arm_at).toBe(
      new Date(declareAt.getTime() - 45 * 60 * 1000).toISOString(),
    );
    expect(dd.declareDatadogIncident).not.toHaveBeenCalled();
  });

  test('drips persona chatter in order after channel discovery and stop cancels the remaining timers', async () => {
    jest.useFakeTimers();
    await demo.arm();
    await demo.declare();
    await discoverChannel();
    await jest.advanceTimersByTimeAsync(30 * 1000);
    await jest.advanceTimersByTimeAsync(30 * 1000);
    expect(slack.postPersonaMessage.mock.calls.map((call) => call[2])).toEqual([
      'sorry to the platform team you all got added, we don\'t have a team on automations',
      'hey, do you need infra help here?',
    ]);
    await demo.stop();
    await jest.advanceTimersByTimeAsync(20 * 60 * 1000);
    expect(slack.postPersonaMessage).toHaveBeenCalledTimes(2);
  });

  test('cleanup is idempotent', async () => {
    await demo.arm();
    await demo.declare();
    await demo.stop();
    await demo.stop();
    expect(dd.resolveDatadogIncident).toHaveBeenCalledTimes(1);
    expect(axios).toHaveBeenCalledTimes(2);
  });
});
