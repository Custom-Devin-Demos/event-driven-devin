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

function fieldsOf(card) {
  return Object.fromEntries(card.body.filter((b) => b.type === 'ColumnSet')
    .flatMap((row) => row.columns.map((col) => [col.items[0].text, col.items[1]])));
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

  test('Teams posts a Slack-style alert card and leaves the session to the Teams responder', async () => {
    const result = await runWithAlertDestination('teams', () => createSessionAndAlert(alert()));
    expect(result).toMatchObject({
      triggered: true, threadTs: null, teams: true, session: null,
    });
    expect(postAlertToSlack).not.toHaveBeenCalled();
    expect(postBugReportToTriage).not.toHaveBeenCalled();
    expect(postDevinSessionLink).not.toHaveBeenCalled();
    expect(createDevinSession).not.toHaveBeenCalled();

    const cards = teamsCards();
    expect(cards).toHaveLength(1);
    const [alertCard] = cards;
    expect(alertCard.body[0].text).toBe('\u{1F6A8} Sentry Alert — Banking Error');
    const fields = fieldsOf(alertCard);
    expect(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.text]))).toMatchObject({
      Error: alert().issueTitle,
      Severity: 'error',
      Type: 'TypeError',
      Location: 'app/services/verticals/banking.js',
      'On-Call': 'Devin AI (auto-investigating)',
      'Triggered by': 'presenter@example.com',
    });
    expect(fields.Location.fontType).toBe('Monospace');
    expect(alertCard.body.filter((b) => b.type === 'ColumnSet')).toHaveLength(4);
    expect(alertCard.body).toContainEqual(expect.objectContaining({
      type: 'TextBlock', text: alert().errorValue, fontType: 'Monospace',
    }));
    expect(alertCard.body.find((b) => b.type === 'ActionSet').actions.map((a) => a.title))
      .toEqual(['View in Sentry', 'View in Datadog']);
    expect(alertCard.body[alertCard.body.length - 1].text).toMatch(/^Service: banking-api \| \d{4}-/);

    const text = axios.post.mock.calls[0][1].text;
    expect(text).toContain('<b>Location:</b> app/services/verticals/banking.js');
    expect(text).toContain('<code>Cannot read properties');
    expect(text).toContain('>View in Sentry</a>');
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
