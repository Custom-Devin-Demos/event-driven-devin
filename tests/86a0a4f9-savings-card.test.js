jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { activateSavingsCard } = require('../app/services/verticals/86a0a4f9');
const customer = require('../config/customers/86a0a4f9');

describe('Lilly LillyDirect savings card activation (86a0a4f9)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('the customer is routed to ServiceNow, not a direct Devin session', () => {
    expect(customer.itsm).toBe('servicenow');
    expect(customer.itsmAssignmentGroup).toBe('Lilly Patient Services Platform Engineering');
    expect(customer.aliases).toContain('lilly-snow');
  });

  test('an unknown patient is rejected without paging anyone', async () => {
    await expect(activateSavingsCard({
      email: 'nobody@example.com',
      patientId: 'LD00000000',
    })).rejects.toMatchObject({
      name: 'PatientNotFoundError',
      statusCode: 404,
      code: 'PATIENT_NOT_FOUND',
    });

    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('a known patient currently fails while the savings program is dereferenced and the incident is raised', async () => {
    await expect(activateSavingsCard({
      email: 'jordan.mitchell@example.com',
      patientId: 'LD70419283',
      devinEmail: 'requester@example.com',
    })).rejects.toMatchObject({ name: 'TypeError' });

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);

    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('86a0a4f9');
    expect(alert.service).toBe('customer-86a0a4f9-savings-card');
    expect(alert.service.length).toBeLessThanOrEqual(32);
    expect(alert.promptAppendix).toContain('COG-GTM/event-driven-devin');
    expect(alert.promptAppendix).toContain('Lilly Patient Services Platform Engineering');
    expect(alert.promptAppendix).toContain('scripts/86a0a4f9-savings-audit.js');
    expect(alert.promptAppendix).toContain('Do not deploy and do not close the incident');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/86a0a4f9/savings-card' },
      { key: 'patientId', value: 'LD70419283' },
    ]));
  });

  test('patient id lookup is case-insensitive and tolerates whitespace', async () => {
    await expect(activateSavingsCard({
      email: ' Harold.Benson@example.com ',
      patientId: 'ld70633107',
      devinEmail: 'requester@example.com',
    })).rejects.toMatchObject({ name: 'TypeError' });

    expect(createSessionAndAlert.mock.calls[0][0].extra.verifiedCoverage).toBe('medicare');
  });
});

describe('Sentry issue-webhook fallback for 86a0a4f9', () => {
  const { isInstantPathEvent } = require('../app/routes/sentry-webhook');

  it('skips tagless activation webhooks that already alerted directly', () => {
    expect(isInstantPathEvent({ culprit: 'buildActivation(app/services/verticals/86a0a4f9)', tags: [] })).toBe(true);
  });

  it('skips tagless activation webhooks identified only by route', () => {
    expect(isInstantPathEvent({ culprit: 'POST /api/86a0a4f9/savings-card', tags: [] })).toBe(true);
  });

  it('keeps tagless cost-estimate route webhooks eligible for the fallback alert', () => {
    expect(isInstantPathEvent({ culprit: 'POST /api/86a0a4f9/cost-estimate', tags: [] })).toBe(false);
  });

  it('keeps tagless cost-estimate webhooks eligible for the fallback alert', () => {
    expect(isInstantPathEvent({ culprit: 'priceFill(app/services/verticals/86a0a4f9)', tags: [] })).toBe(false);
  });

  it('keeps unrelated buildActivation errors eligible for the fallback alert', () => {
    expect(isInstantPathEvent({ culprit: 'buildActivation(app/services/other)', tags: [] })).toBe(false);
  });
});
