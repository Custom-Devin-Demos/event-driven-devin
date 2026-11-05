/* global afterEach, beforeEach, describe, expect, jest, test */
jest.mock('../app/telemetry/logger', () => ({ info: jest.fn(), warn: jest.fn() }));
jest.mock('../app/services/slack', () => ({
  findChannelByNameFragment: jest.fn(), joinChannel: jest.fn(), inviteToChannel: jest.fn(),
}));
const { findChannelByNameFragment, joinChannel, inviteToChannel } = require('../app/services/slack');
const { queueIncidentChannelInvites, CHANNEL_RETRY_MS, MAX_ATTEMPTS } = require('../app/services/datadog-incident-slack');
const USER = 'U0TESTUSER1';
const CHANNEL = { id: 'C0INCIDENT', name: 'sev-1-incident-211-state-street' };

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  delete process.env.INCIDENT_LAB_SLACK_BOT_TOKEN;
  delete process.env.SLACK_BOT_TOKEN;
  process.env.SLACK_ONCALL_BOT_TOKEN = 'test-bot';
  findChannelByNameFragment.mockReset().mockResolvedValue(CHANNEL);
  joinChannel.mockReset().mockResolvedValue(undefined);
  inviteToChannel.mockReset().mockResolvedValue(true);
});
afterEach(() => {
  jest.useRealTimers();
  delete process.env.SLACK_ONCALL_BOT_TOKEN;
});

describe('Datadog incident channel participants', () => {
  test.each([211, '211'])('waits for Datadog channel creation with public id %j, joins, then invites only valid configured users', async (publicId) => {
    findChannelByNameFragment.mockResolvedValueOnce(null);
    expect(queueIncidentChannelInvites({ publicId, userIds: [USER, USER, '<!channel>'] })).toBe(true);
    await jest.advanceTimersByTimeAsync(0);
    expect(inviteToChannel).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(CHANNEL_RETRY_MS);
    expect(findChannelByNameFragment).toHaveBeenCalledWith('test-bot', 'incident-211-');
    expect(joinChannel).toHaveBeenCalledWith('test-bot', CHANNEL.id);
    expect(inviteToChannel).toHaveBeenCalledWith('test-bot', CHANNEL.id, [USER]);
    expect(joinChannel.mock.invocationCallOrder[0]).toBeLessThan(inviteToChannel.mock.invocationCallOrder[0]);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('retries an unsuccessful invite without rescanning every channel', async () => {
    inviteToChannel.mockResolvedValueOnce(false);
    queueIncidentChannelInvites({ publicId: 211, userIds: [USER] });
    await jest.advanceTimersByTimeAsync(2 * CHANNEL_RETRY_MS);
    expect(findChannelByNameFragment).toHaveBeenCalledTimes(1);
    expect(inviteToChannel).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('handles Slack failures and stops after the bounded discovery window', async () => {
    findChannelByNameFragment.mockRejectedValueOnce(new Error('Slack temporarily unavailable')).mockResolvedValue(null);
    queueIncidentChannelInvites({ publicId: 211, userIds: [USER] });
    await jest.advanceTimersByTimeAsync(MAX_ATTEMPTS * CHANNEL_RETRY_MS);
    expect(findChannelByNameFragment).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(inviteToChannel).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a partial invitation failure retries only the remaining participant', async () => {
    inviteToChannel.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    queueIncidentChannelInvites({ publicId: 211, userIds: [USER, 'U0TESTUSER2'] });
    await jest.advanceTimersByTimeAsync(2 * CHANNEL_RETRY_MS);
    expect(inviteToChannel.mock.calls.map(([, , users]) => users)).toEqual([[USER], ['U0TESTUSER2'], ['U0TESTUSER2']]);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('uses the Incident Lab bot when its invitation scopes are configured', async () => {
    process.env.INCIDENT_LAB_SLACK_BOT_TOKEN = 'test-sre-bot';
    queueIncidentChannelInvites({ publicId: 211, userIds: [USER] });
    await jest.advanceTimersByTimeAsync(0);
    expect(joinChannel).toHaveBeenCalledWith('test-sre-bot', CHANNEL.id);
    delete process.env.INCIDENT_LAB_SLACK_BOT_TOKEN;
  });

  test('skips missing credentials and rejects malformed incident ids or participants', () => {
    delete process.env.SLACK_ONCALL_BOT_TOKEN;
    expect(queueIncidentChannelInvites({ publicId: 211, userIds: [USER] })).toBe(false);
    process.env.SLACK_ONCALL_BOT_TOKEN = 'test-bot';
    expect(queueIncidentChannelInvites({ publicId: '../211', userIds: [USER] })).toBe(false);
    expect(queueIncidentChannelInvites({ publicId: 211, userIds: ['<!channel>'] })).toBe(false);
    expect(findChannelByNameFragment).not.toHaveBeenCalled();
  });

  test.each(['0', '0211', '2.11', '2e2', ' 211', '211 ', '9007199254740992', {}, null])('rejects noncanonical or unsafe public id %j', (publicId) => {
    expect(queueIncidentChannelInvites({ publicId, userIds: [USER] })).toBe(false);
    expect(findChannelByNameFragment).not.toHaveBeenCalled();
  });
});
