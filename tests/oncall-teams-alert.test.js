/* global afterEach, beforeEach, describe, expect, jest, test */

jest.mock('axios');
jest.mock('../app/services/slack', () => ({
  OWNER_DISCLAIMER: 'fictional on-call persona',
  postMessage: jest.fn().mockResolvedValue('1700000000.000100'),
  postThreadReply: jest.fn().mockResolvedValue('1700000000.000200'),
  lookupSlackUserByEmail: jest.fn().mockResolvedValue(null),
  findChannelByNameFragment: jest.fn().mockResolvedValue(null),
  joinChannel: jest.fn().mockResolvedValue(undefined),
  postPersonaMessage: jest.fn().mockResolvedValue(undefined),
  inviteToChannel: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../app/services/devin-api', () => ({
  createDevinSession: jest.fn().mockResolvedValue({ sessionId: 'session-abc', url: 'https://app.devin.ai/sessions/session-abc' }),
}));
jest.mock('../app/services/sonar-pr-trigger', () => ({ scheduleVulnerablePR: jest.fn() }));

const axios = require('axios');
const { postMessage, postThreadReply } = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');
const { postOncallAlert } = require('../app/services/oncall');
const { getOncallSkin } = require('../config/oncall-skins');

const LOANTRACK = getOncallSkin('9ecaa5d1');
const TEAMS_URL = 'https://teams.example.test/workflows/hook';
const ENV_KEYS = ['SLACK_ONCALL_BOT_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_ONCALL_ALERTS_CHANNEL_ID', 'ONCALL_TEAMS_WEBHOOK_URL', 'ONCALL_TEAMS_ALL_ALERTS'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function setEnv({ slack, teams }) {
  ENV_KEYS.forEach((k) => delete process.env[k]);
  if (slack) {
    process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0TEST';
  }
  if (teams) process.env.ONCALL_TEAMS_WEBHOOK_URL = TEAMS_URL;
}

function teamsCard() {
  const [url, payload] = axios.post.mock.calls[0];
  expect(url).toBe(TEAMS_URL);
  expect(payload.type).toBe('message');
  expect(payload.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
  return payload.attachments[0].content;
}

describe('On-Call alerts routed to Microsoft Teams', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    axios.post.mockResolvedValue({ status: 202 });
  });

  afterEach(() => {
    ENV_KEYS.forEach((k) => {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    });
  });

  test('without a Teams webhook the alert is Slack-only and unchanged', async () => {
    setEnv({ slack: true, teams: false });
    const result = await postOncallAlert('banking', { runRef: 'run-abc' });
    expect(result).toEqual({ ok: true, ts: '1700000000.000100', channel: 'C0TEST' });
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('posts the same LoanTrack alert to Slack and Teams, with no session', async () => {
    setEnv({ slack: true, teams: true });
    const result = await postOncallAlert('banking', { runRef: 'run-abc', skin: LOANTRACK, devinEmail: 'julia@example.com' });

    expect(result).toMatchObject({ ok: true, channel: 'C0TEST', teams: true });
    expect(createDevinSession).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledTimes(1);

    const card = teamsCard();
    expect(card.type).toBe('AdaptiveCard');
    const text = JSON.stringify(card);
    expect(text).toContain('[Triggered] p95 latency — payment release submissions');
    expect(text).toContain('loantrack-disbursement-api (LoanTrack)');
    expect(text).toContain('run-abc');
    expect(text).toContain('julia@example.com');
    expect(text).toContain('/oncall/c/9ecaa5d1');
    expect(text).not.toMatch(/<@|:rotating_light:/);
    const plain = axios.post.mock.calls[0][1].text;
    expect(plain).toContain('<b>[Triggered] p95 latency — payment release submissions</b>'.replace('<b>', '<b>\u{1F6A8} '));
    expect(plain).toContain('<b>Service:</b> loantrack-disbursement-api (LoanTrack)');
    expect(plain).toContain('<b>Symptom:</b>');
    expect(plain).toContain('>View in Datadog</a>');
    expect(JSON.stringify(postMessage.mock.calls[0][3])).toContain('loantrack-disbursement-api (LoanTrack)');
  });

  test('a failed Teams post never blocks the Slack alert', async () => {
    setEnv({ slack: true, teams: true });
    axios.post.mockRejectedValue(Object.assign(new Error('boom'), { response: { status: 500 } }));
    const result = await postOncallAlert('banking', { runRef: 'run-abc', skin: LOANTRACK });
    expect(result).toEqual({ ok: true, ts: '1700000000.000100', channel: 'C0TEST' });
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  test('Teams alone is enough to deliver the alert', async () => {
    setEnv({ slack: false, teams: true });
    const result = await postOncallAlert('banking', { runRef: 'run-abc', skin: LOANTRACK });
    expect(result).toEqual({ ok: true, teams: true });
    expect(postMessage).not.toHaveBeenCalled();
    expect(teamsCard().actions[0]).toMatchObject({ type: 'Action.OpenUrl', title: 'View in Datadog' });
  });

  test('Slack is posted without waiting for a slow Teams webhook', async () => {
    setEnv({ slack: true, teams: true });
    let releaseTeams;
    axios.post.mockReturnValue(new Promise((resolve) => { releaseTeams = resolve; }));
    const pending = postOncallAlert('banking', { runRef: 'run-abc', skin: LOANTRACK });
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(postMessage).toHaveBeenCalledTimes(1);
    releaseTeams({ status: 202 });
    await expect(pending).resolves.toMatchObject({ ok: true, channel: 'C0TEST', teams: true });
  });

  test('a Slack failure still reports the Teams delivery', async () => {
    setEnv({ slack: true, teams: true });
    postMessage.mockRejectedValueOnce(new Error('channel_not_found'));
    const result = await postOncallAlert('banking', { runRef: 'run-abc', skin: LOANTRACK });
    expect(result).toEqual({ ok: true, teams: true });
  });

  test('a Slack failure without Teams still throws', async () => {
    setEnv({ slack: true, teams: false });
    postMessage.mockRejectedValueOnce(new Error('channel_not_found'));
    await expect(postOncallAlert('banking', { runRef: 'run-abc' })).rejects.toThrow('channel_not_found');
  });

  test('Teams-only alerts still run opted-in skin automation, without a Slack thread reply', async () => {
    setEnv({ slack: false, teams: true });
    const skin = { ...getOncallSkin('4b663efb'), teamsAlerts: true };
    const result = await postOncallAlert(skin.vertical, { skin });
    expect(createDevinSession).toHaveBeenCalledTimes(1);
    expect(postThreadReply).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, teams: true, sessionUrl: 'https://app.devin.ai/sessions/session-abc' });
  });

  test('skins without teamsAlerts stay Slack-only even with a Teams webhook', async () => {
    setEnv({ slack: true, teams: true });
    const skin = getOncallSkin('4b663efb');
    expect(skin.teamsAlerts).toBeFalsy();
    const unskinned = await postOncallAlert('banking', { runRef: 'run-abc' });
    const skinned = await postOncallAlert(skin.vertical, { runRef: 'run-def', skin });
    expect(unskinned).toEqual({ ok: true, ts: '1700000000.000100', channel: 'C0TEST' });
    expect(skinned.teams).toBeUndefined();
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('a Teams webhook alone does not deliver alerts for other skins', async () => {
    setEnv({ slack: false, teams: true });
    const result = await postOncallAlert('banking', { runRef: 'run-abc' });
    expect(result).toMatchObject({ ok: false, skipped: true });
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('ONCALL_TEAMS_ALL_ALERTS sends skinless and non-Teams skin alerts to Teams', async () => {
    setEnv({ slack: true, teams: true });
    process.env.ONCALL_TEAMS_ALL_ALERTS = 'true';
    const skin = getOncallSkin('4b663efb');
    const unskinned = await postOncallAlert('banking', { runRef: 'run-abc' });
    const skinned = await postOncallAlert(skin.vertical, { runRef: 'run-def', skin });
    expect(unskinned).toMatchObject({ ok: true, channel: 'C0TEST', teams: true });
    expect(skinned).toMatchObject({ ok: true, channel: 'C0TEST', teams: true });
    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(teamsCard())).toContain('run-abc');
  });

  test('skips when neither Slack nor Teams is configured', async () => {
    setEnv({ slack: false, teams: false });
    const result = await postOncallAlert('banking');
    expect(result).toMatchObject({ ok: false, skipped: true });
    expect(axios.post).not.toHaveBeenCalled();
  });
});
