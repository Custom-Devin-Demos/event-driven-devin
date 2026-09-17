jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

jest.mock('../app/telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { incrementMetric } = require('../app/telemetry/datadog');
const {
  submitPayment,
  resolveAddressingProfile,
  NPP_ADDRESSING_PROFILES,
  PAYMENTS_OPERATIONS_QUEUE,
} = require('../app/services/verticals/cba');

const ABN_PAYMENT = {
  fromAccount: '062-000 10345678',
  paymentMethod: 'payid',
  payeeName: 'Sunrise Plumbing Pty Ltd',
  payId: '54 692 411 003',
  payIdType: 'abn',
  amount: 1480,
  description: 'Invoice 80114',
};

describe('CommBank NetBank payment (cba)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
    incrementMetric.mockClear();
  });

  test('ABN PayID payments settle successfully without raising an alert', async () => {
    const result = await submitPayment(ABN_PAYMENT);

    expect(result.success).toBe(true);
    expect(result.settlementRail).toBe('Osko');
    expect(result.payeeName).toBe('Sunrise Plumbing Pty Ltd (ABN PayID)');
    expect(result.totalDebited).toBe(1480);
    expect(result.receiptNumber).toMatch(/^NB\d{9}$/);
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('every registered PayID type resolves an addressing profile with a directory service', () => {
    for (const payIdType of Object.keys(NPP_ADDRESSING_PROFILES)) {
      const profile = resolveAddressingProfile({ payIdType });
      expect(profile.directoryService).toBe('NPP Addressing Service');
      expect(typeof profile.label).toBe('string');
    }
  });

  test('email and mobile PayID payments keep settling', async () => {
    for (const payIdType of ['email', 'mobile']) {
      const result = await submitPayment({
        ...ABN_PAYMENT,
        payIdType,
        payId: payIdType === 'email' ? 'accounts@sunriseplumbing.com.au' : '0412 345 678',
      });
      expect(result.success).toBe(true);
    }
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('an unregistered PayID type is referred to the payments operations queue, not thrown as a TypeError', async () => {
    const failure = submitPayment({ ...ABN_PAYMENT, payIdType: 'acn' });

    await expect(failure).rejects.not.toBeInstanceOf(TypeError);
    await expect(submitPayment({ ...ABN_PAYMENT, payIdType: 'acn' })).rejects.toMatchObject({
      name: 'PaymentOperationsError',
      code: 'ADDRESSING_PROFILE_UNREGISTERED',
      statusCode: 422,
      queue: PAYMENTS_OPERATIONS_QUEUE,
    });

    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(incrementMetric).toHaveBeenCalledWith(
      'cba_payment.operations_referral',
      expect.objectContaining({ queue: PAYMENTS_OPERATIONS_QUEUE, errorCode: 'ADDRESSING_PROFILE_UNREGISTERED' }),
    );
  });

  test('a PayID type inherited from Object.prototype is not mistaken for a profile', async () => {
    await expect(submitPayment({ ...ABN_PAYMENT, payIdType: 'constructor' })).rejects.toMatchObject({
      name: 'PaymentOperationsError',
      code: 'ADDRESSING_PROFILE_UNREGISTERED',
    });
  });

  test('validation failures still return 400s', async () => {
    await expect(submitPayment({ ...ABN_PAYMENT, payIdType: '' })).rejects.toMatchObject({
      name: 'ValidationError',
      statusCode: 400,
    });
    await expect(submitPayment({ ...ABN_PAYMENT, amount: 99999 })).rejects.toMatchObject({
      name: 'ValidationError',
      statusCode: 400,
    });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});
