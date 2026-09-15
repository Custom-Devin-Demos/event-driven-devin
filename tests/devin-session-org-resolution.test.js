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
  isConfigured: jest.fn(() => false),
  createIncident: jest.fn(),
}));

jest.mock('../app/services/sonar-pr-trigger', () => ({
  scheduleVulnerablePR: jest.fn(),
}));

jest.mock('../app/services/session-rate-limiter', () => ({
  canCreateSession: jest.fn(() => ({ allowed: true, current: 0, max: 10 })),
  reserveSession: jest.fn(() => jest.fn()),
}));

jest.mock('../app/services/oncall-suppression', () => ({
  legacyAlertsSuppressed: jest.fn(() => false),
}));

const { createDevinSession } = require('../app/services/devin-api');
const { scheduleVulnerablePR } = require('../app/services/sonar-pr-trigger');
const { createSessionAndAlert } = require('../app/services/devin-session');

const portalAlert = {
  issueTitle: 'TypeError: Null check operator used on a null value',
  errorType: 'TypeError',
  errorValue: 'Null check operator used on a null value',
  service: 'customer-5b992ae7-portal',
  customer: '5b992ae7',
  level: 'error',
  tags: [],
};

describe('Devin org resolution for direct (non-browser) reports', () => {
  beforeEach(() => {
    process.env.SLACK_CHANNEL_ID = 'C123';
    process.env.DEVIN_SERVICE_KEY_5B992AE7 = 'portal-key';
    process.env.DEVIN_USER_ID_5B992AE7 = 'user-portal';
    process.env.DEVIN_ORG_ID_5B992AE7 = 'org-portal';
    createDevinSession.mockClear();
    scheduleVulnerablePR.mockClear();
  });

  afterAll(() => {
    delete process.env.SLACK_CHANNEL_ID;
    delete process.env.DEVIN_SERVICE_KEY_5B992AE7;
    delete process.env.DEVIN_USER_ID_5B992AE7;
    delete process.env.DEVIN_ORG_ID_5B992AE7;
  });

  test('uses the customer-scoped org and user when the report carries neither', async () => {
    await createSessionAndAlert({ ...portalAlert });

    expect(createDevinSession).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        apiKey: 'portal-key',
        orgId: 'org-portal',
        userId: 'user-portal',
      }),
    );
    expect(scheduleVulnerablePR).toHaveBeenCalledWith(0, '5b992ae7', 'user-portal', 'org-portal');
  });

  test('report-supplied org/user still win over customer config', async () => {
    await createSessionAndAlert({
      ...portalAlert,
      devinOrgId: 'org-from-page',
      devinUserId: 'user-from-page',
    });

    expect(createDevinSession).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ orgId: 'org-from-page', userId: 'user-from-page' }),
    );
  });

  test('leaves orgId empty when neither report nor customer config set one', async () => {
    delete process.env.DEVIN_ORG_ID_5B992AE7;

    await createSessionAndAlert({ ...portalAlert });

    expect(createDevinSession).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ orgId: '' }),
    );
  });
});
