jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { lookupCoverage } = require('../app/services/verticals/7c6a6ef9');

describe('enGen member coverage status (7c6a6ef9)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('an unknown member is rejected without paging anyone', async () => {
    await expect(lookupCoverage({
      email: 'nobody@example.com',
      memberId: 'HM-00000000',
    })).rejects.toMatchObject({
      name: 'MemberNotFoundError',
      statusCode: 404,
      code: 'MEMBER_NOT_FOUND',
    });

    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('a known member currently fails while the plan is dereferenced and the incident is raised', async () => {
    await expect(lookupCoverage({
      email: 'sarah.johnson@example.com',
      memberId: 'HM-20481973',
      devinEmail: 'requester@example.com',
    })).rejects.toMatchObject({ name: 'TypeError' });

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);

    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('7c6a6ef9');
    expect(alert.service).toBe('customer-7c6a6ef9-member-coverage');
    expect(alert.promptAppendix).toContain('Member Benefits Platform Engineering');
    expect(alert.promptAppendix).toContain('scripts/7c6a6ef9-benefits-audit.js');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/7c6a6ef9/coverage' },
      { key: 'memberId', value: 'HM-20481973' },
    ]));
  });
});
