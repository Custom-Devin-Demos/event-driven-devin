jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { lookupCoverage } = require('../app/services/verticals/907b82bd');
const customer = require('../config/customers/907b82bd');

describe('CVS Health Aetna member coverage status (907b82bd)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('the customer is routed to ServiceNow, not a direct Devin session', () => {
    expect(customer.itsm).toBe('servicenow');
    expect(customer.itsmAssignmentGroup).toBe('Aetna Member Benefits Platform Engineering');
    expect(customer.aliases).toContain('cvs-snow');
  });

  test('an unknown member is rejected without paging anyone', async () => {
    await expect(lookupCoverage({
      email: 'nobody@example.com',
      memberId: 'W000000000',
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
      memberId: 'W204819730',
      devinEmail: 'requester@example.com',
    })).rejects.toMatchObject({ name: 'TypeError' });

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);

    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('907b82bd');
    expect(alert.service).toBe('customer-907b82bd-member-coverage');
    expect(alert.promptAppendix).toContain('COG-GTM/event-driven-devin');
    expect(alert.promptAppendix).toContain('Aetna Member Benefits Platform Engineering');
    expect(alert.promptAppendix).toContain('scripts/907b82bd-benefits-audit.js');
    expect(alert.promptAppendix).toContain('Do not deploy and do not close the incident');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/907b82bd/coverage' },
      { key: 'memberId', value: 'W204819730' },
    ]));
  });

  test('member id lookup is case-insensitive and tolerates whitespace', async () => {
    await expect(lookupCoverage({
      email: ' David.Kim@example.com ',
      memberId: 'w205598412',
      devinEmail: 'requester@example.com',
    })).rejects.toMatchObject({ name: 'TypeError' });

    expect(createSessionAndAlert.mock.calls[0][0].extra.enrolledPlan).toBe('hmo');
  });
});
