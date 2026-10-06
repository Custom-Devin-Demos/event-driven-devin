/* global afterEach, beforeEach, describe, expect, jest, test */

jest.mock('axios');
jest.mock('../app/services/slack', () => ({
  postAlertToSlack: jest.fn().mockResolvedValue('thread-123'),
  postBugReportToTriage: jest.fn().mockResolvedValue(undefined),
  postDevinSessionLink: jest.fn().mockResolvedValue('reply-123'),
  postIncidentLink: jest.fn().mockResolvedValue('reply-incident-123'),
}));
jest.mock('../app/services/devin-api', () => ({
  createDevinSession: jest.fn().mockResolvedValue({
    sessionId: 'session-123',
    url: 'https://app.devin.ai/sessions/session-123',
  }),
}));
jest.mock('../app/services/sonar-pr-trigger', () => ({ scheduleVulnerablePR: jest.fn() }));
jest.mock('../app/services/session-rate-limiter', () => ({
  canCreateSession: jest.fn(() => ({ allowed: true, current: 0, max: 10 })),
  reserveSession: jest.fn(() => jest.fn()),
}));

const axios = require('axios');
const {
  postAlertToSlack, postBugReportToTriage, postDevinSessionLink,
} = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');
const { createSessionAndAlert } = require('../app/services/devin-session');
const {
  alertDestinationFromCookie, runWithAlertDestination,
  currentAlertDestination, selectedAlertDestination,
} = require('../app/services/alert-destination');

const TEAMS_URL = 'https://default1.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/abc';
const savedEnv = { url: process.env.AUTOMATIONS_TEAMS_WEBHOOK_URL, channel: process.env.SLACK_CHANNEL_ID };

const alert = () => ({
  issueTitle: 'TypeError: Cannot read properties of undefined (reading \'limit\')',
  errorType: 'TypeError',
  errorValue: 'Cannot read properties of undefined (reading \'limit\')',
  culprit: 'app/services/verticals/banking.js',
  verticalLabel: 'Banking',
  service: 'banking-api',
  issueUrl: 'https://sentry.io/issues/1',
  devinEmail: 'presenter@example.com',
});

function teamsCards() {
  return axios.post.mock.calls.map(([url, payload]) => {
    expect(url).toBe(TEAMS_URL);
    expect(payload.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
    return payload.attachments[0].content;
  });
}

function factsOf(card) {
  return Object.fromEntries(card.body.find((b) => b.type === 'FactSet').facts.map((f) => [f.title, f.value]));
}

describe('hub demo alert destination (Slack / Teams)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    axios.post.mockResolvedValue({ status: 202 });
    process.env.SLACK_CHANNEL_ID = 'C123';
    process.env.AUTOMATIONS_TEAMS_WEBHOOK_URL = TEAMS_URL;
  });

  afterEach(() => {
    if (savedEnv.url === undefined) delete process.env.AUTOMATIONS_TEAMS_WEBHOOK_URL;
    else process.env.AUTOMATIONS_TEAMS_WEBHOOK_URL = savedEnv.url;
    if (savedEnv.channel === undefined) delete process.env.SLACK_CHANNEL_ID;
    else process.env.SLACK_CHANNEL_ID = savedEnv.channel;
  });

  test('without a destination choice the alert is Slack-only and unchanged', async () => {
    const result = await createSessionAndAlert(alert());
    expect(result).toMatchObject({ triggered: true, threadTs: 'thread-123' });
    expect(result.teams).toBeUndefined();
    expect(postAlertToSlack).toHaveBeenCalledTimes(1);
    expect(postBugReportToTriage).toHaveBeenCalledTimes(1);
    expect(postDevinSessionLink).toHaveBeenCalledWith('thread-123', 'https://app.devin.ai/sessions/session-123');
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('Teams posts the alert card and the session link, with nothing sent to Slack', async () => {
    const result = await runWithAlertDestination('teams', () => createSessionAndAlert(alert()));
    expect(result).toMatchObject({ triggered: true, threadTs: null, teams: true });
    expect(postAlertToSlack).not.toHaveBeenCalled();
    expect(postBugReportToTriage).not.toHaveBeenCalled();
    expect(postDevinSessionLink).not.toHaveBeenCalled();
    expect(createDevinSession.mock.calls[0][0]).not.toContain('Slack Thread');

    const [alertCard, followUp] = teamsCards();
    expect(alertCard.body[0].text).toBe('\u{1F6A8} Sentry Alert — Banking Error');
    expect(factsOf(alertCard)).toMatchObject({
      Error: alert().issueTitle,
      Type: 'TypeError',
      Location: 'app/services/verticals/banking.js',
      'On-Call': 'Devin AI (auto-investigating)',
      'Triggered by': 'presenter@example.com',
      Service: 'banking-api',
    });
    expect(alertCard.body.some((b) => b.text === 'Message')).toBe(true);
    expect(alertCard.actions.map((a) => a.title)).toEqual(['View in Sentry', 'View in Datadog']);
    expect(followUp.body[0].text).toMatch(/Devin is investigating/);
    expect(followUp.actions).toEqual([
      { type: 'Action.OpenUrl', title: 'View in Devin', url: 'https://app.devin.ai/sessions/session-123' },
    ]);
  });

  test('Teams without a server webhook falls back to Slack', async () => {
    delete process.env.AUTOMATIONS_TEAMS_WEBHOOK_URL;
    const result = await runWithAlertDestination('teams', () => createSessionAndAlert(alert()));
    expect(result).toMatchObject({ triggered: true, threadTs: 'thread-123' });
    expect(postAlertToSlack).toHaveBeenCalledTimes(1);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('a failed Teams-only post delivers nothing and starts no session', async () => {
    axios.post.mockRejectedValue(new Error('boom'));
    const result = await runWithAlertDestination('teams', () => createSessionAndAlert(alert()));
    expect(result).toBeNull();
    expect(createDevinSession).not.toHaveBeenCalled();
  });
});

describe('selectedAlertDestination', () => {
  test('is null without a browser choice while currentAlertDestination defaults to Slack', () => {
    runWithAlertDestination(null, () => {
      expect(selectedAlertDestination()).toBeNull();
      expect(currentAlertDestination()).toBe('slack');
    });
    runWithAlertDestination('slack', () => expect(selectedAlertDestination()).toBe('slack'));
    expect(selectedAlertDestination()).toBeNull();
  });
});

describe('alertDestinationFromCookie', () => {
  test('reads only known values from the alert_destination cookie', () => {
    expect(alertDestinationFromCookie('a=1; alert_destination=teams; b=2')).toBe('teams');
    expect(alertDestinationFromCookie('alert_destination=both')).toBeNull();
    expect(alertDestinationFromCookie('alert_destination=slack')).toBe('slack');
    expect(alertDestinationFromCookie('alert_destination=teamsx')).toBeNull();
    expect(alertDestinationFromCookie('xalert_destination=teams')).toBeNull();
    expect(alertDestinationFromCookie(undefined)).toBeNull();
  });
});
