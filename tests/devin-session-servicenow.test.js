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

jest.mock('../app/services/servicenow', () => ({
  isConfigured: jest.fn(),
  createIncident: jest.fn(),
}));

jest.mock('../app/services/sonar-pr-trigger', () => ({
  scheduleVulnerablePR: jest.fn(),
}));

jest.mock('../app/services/session-rate-limiter', () => ({
  canCreateSession: jest.fn(() => ({
    allowed: true,
    current: 0,
    max: 10,
  })),
  reserveSession: jest.fn(() => jest.fn()),
}));

jest.mock('../app/services/oncall-suppression', () => ({
  legacyAlertsSuppressed: jest.fn(() => false),
}));

const {
  postAlertToSlack,
  postDevinSessionLink,
  postIncidentLink,
} = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');
const servicenow = require('../app/services/servicenow');
const { scheduleVulnerablePR } = require('../app/services/sonar-pr-trigger');
const { createSessionAndAlert } = require('../app/services/devin-session');

const baseAlert = {
  issueTitle: 'LimitExceededError: Amount exceeds daily limit',
  issueId: 'issue-123',
  errorType: 'LimitExceededError',
  errorValue: 'Amount exceeds daily limit',
  service: 'customer-6f43e66c-zelle-send',
  level: 'error',
  tags: [],
};

describe('ServiceNow customer routing', () => {
  beforeEach(() => {
    process.env.SLACK_CHANNEL_ID = 'C123';
    postAlertToSlack.mockClear();
    postDevinSessionLink.mockClear();
    postIncidentLink.mockClear();
    createDevinSession.mockClear();
    scheduleVulnerablePR.mockClear();
    servicenow.isConfigured.mockReset();
    servicenow.createIncident.mockReset();
  });

  afterAll(() => {
    delete process.env.SLACK_CHANNEL_ID;
  });

  test('routes the Zelle customer to ServiceNow without creating a Devin session', async () => {
    servicenow.isConfigured.mockReturnValue(true);
    servicenow.createIncident.mockResolvedValue({
      number: 'INC0010023',
      sysId: 'sys-123',
      url: 'https://dev-instance.service-now.com/nav_to.do?uri=incident.do?sys_id=sys-123',
    });

    const result = await createSessionAndAlert({
      ...baseAlert,
      customer: '6f43e66c',
    });

    expect(servicenow.createIncident).toHaveBeenCalledWith({
      shortDescription: baseAlert.issueTitle,
      description: expect.stringContaining('*Slack Thread:* channel=C123 thread_ts=thread-123'),
      assignmentGroup: 'Digital Payments Engineering',
      correlationId: 'issue-123',
      cmdbCi: baseAlert.service,
    });
    expect(postIncidentLink).toHaveBeenCalledWith(
      'thread-123',
      expect.objectContaining({ number: 'INC0010023' }),
      'Digital Payments Engineering'
    );
    expect(createDevinSession).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      triggered: true,
      throttled: false,
      threadTs: 'thread-123',
      session: null,
      incident: { number: 'INC0010023' },
    });
  });

  test('keeps the direct Devin path for a non-ITSM customer', async () => {
    servicenow.isConfigured.mockReturnValue(true);

    const result = await createSessionAndAlert({
      ...baseAlert,
      customer: 'default',
    });

    expect(createDevinSession).toHaveBeenCalled();
    expect(servicenow.createIncident).not.toHaveBeenCalled();
    expect(postDevinSessionLink).toHaveBeenCalled();
    expect(result.session).toEqual(expect.objectContaining({ sessionId: 'session-123' }));
  });
});
