jest.mock('axios');

const axios = require('axios');
const servicenow = require('../app/services/servicenow');

const envKeys = [
  'SERVICENOW_INSTANCE_URL',
  'SERVICENOW_USER',
  'SERVICENOW_PASSWORD',
];

describe('ServiceNow incident service', () => {
  const savedEnv = {};

  beforeAll(() => {
    for (const key of envKeys) savedEnv[key] = process.env[key];
  });

  beforeEach(() => {
    for (const key of envKeys) delete process.env[key];
    axios.post.mockReset();
  });

  afterAll(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  test('returns null without making an HTTP call when not configured', async () => {
    expect(servicenow.isConfigured()).toBe(false);
    await expect(servicenow.createIncident({
      shortDescription: 'Test failure',
      description: 'Details',
    })).resolves.toBeNull();
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('creates an incident with normalized URL, auth, and ServiceNow fields', async () => {
    process.env.SERVICENOW_INSTANCE_URL = 'https://dev-instance.service-now.com///';
    process.env.SERVICENOW_USER = 'test-user';
    process.env.SERVICENOW_PASSWORD = 'test-password';
    axios.post.mockResolvedValue({
      data: {
        result: {
          number: 'INC0010023',
          sys_id: 'sys-123',
        },
      },
    });

    const incident = await servicenow.createIncident({
      shortDescription: 'LimitExceededError: Amount too large',
      description: 'Investigation prompt',
      assignmentGroup: 'Digital Payments Engineering',
      correlationId: 'sentry-123',
      cmdbCi: 'customer-6f43e66c-zelle-send',
    });

    expect(axios.post).toHaveBeenCalledWith(
      'https://dev-instance.service-now.com/api/now/table/incident',
      {
        short_description: 'LimitExceededError: Amount too large',
        description: 'Investigation prompt',
        impact: '2',
        urgency: '1',
        category: 'software',
        assignment_group: 'Digital Payments Engineering',
        correlation_id: 'sentry-123',
        correlation_display: 'event-driven-devin',
        contact_type: 'monitoring',
        cmdb_ci: 'customer-6f43e66c-zelle-send',
      },
      expect.objectContaining({
        auth: {
          username: 'test-user',
          password: 'test-password',
        },
        timeout: 10000,
      })
    );
    expect(incident).toEqual({
      number: 'INC0010023',
      sysId: 'sys-123',
      url: 'https://dev-instance.service-now.com/nav_to.do?uri=incident.do?sys_id=sys-123',
    });
  });

  test('returns null when the ServiceNow request rejects', async () => {
    process.env.SERVICENOW_INSTANCE_URL = 'https://dev-instance.service-now.com';
    process.env.SERVICENOW_USER = 'test-user';
    process.env.SERVICENOW_PASSWORD = 'test-password';
    axios.post.mockRejectedValue(new Error('request failed'));

    await expect(servicenow.createIncident({
      shortDescription: 'Test failure',
      description: 'Details',
      correlationId: 'thread-123',
    })).resolves.toBeNull();
  });
});
