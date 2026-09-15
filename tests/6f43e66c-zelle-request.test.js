jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { requestMoney } = require('../app/services/verticals/6f43e66c');

describe('consumer Zelle request path (6f43e66c)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('a Standard account can request $100', async () => {
    const result = await requestMoney({
      fromAccountId: 'adv-savings-2043',
      recipientId: 'rcp-maria',
      amount: 100,
    });

    expect(result.status).toBe('requested');
    expect(result.amount).toBe(100);
    expect(result.limitProfile).toBe('Standard');
    expect(result.recipient).toBe('Maria Alvarez');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('a Platinum $5,000 request is silently declined under the planted Standard fallback', async () => {
    await expect(requestMoney({
      fromAccountId: 'adv-relationship-chk-8820',
      recipientId: 'rcp-maria',
      amount: 5000,
    })).rejects.toMatchObject({
      name: 'LimitExceededError',
      statusCode: 422,
      code: 'REQUEST_LIMIT',
      message: 'Requests from this account are limited to $3500 (Standard)',
    });

    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test.each([
    ['unknown account', { fromAccountId: 'missing', recipientId: 'rcp-maria', amount: 100 }, 'ACCOUNT_NOT_ELIGIBLE'],
    ['unknown recipient', { fromAccountId: 'adv-savings-2043', recipientId: 'missing', amount: 100 }, 'RECIPIENT_NOT_ENROLLED'],
    ['non-positive amount', { fromAccountId: 'adv-savings-2043', recipientId: 'rcp-maria', amount: 0 }, 'INVALID_AMOUNT'],
  ])('%s is rejected as a validation error', async (_caseName, data, code) => {
    await expect(requestMoney(data)).rejects.toMatchObject({
      name: 'ValidationError',
      statusCode: 400,
      code,
    });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});
