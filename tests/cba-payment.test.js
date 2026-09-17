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
  PAYMENT_OPERATIONS_QUEUE,
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

  test('ABN PayID payments settle instead of throwing a TypeError', async () => {
    const result = await submitPayment({ ...ABN_PAYMENT });

    expect(result.success).toBe(true);
    expect(result.settlementRail).toBe('Osko');
    expect(result.payeeName).toBe('Sunrise Plumbing Pty Ltd (ABN PayID)');
    expect(result.totalDebited).toBe(1480);
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('every registered PayID type resolves a profile naming a directory service', () => {
    for (const payIdType of Object.keys(NPP_ADDRESSING_PROFILES)) {
      const profile = resolveAddressingProfile({ payIdType });
      expect(profile.directoryService).toBe('NPP Addressing Service');
      expect(typeof profile.label).toBe('string');
    }
  });

  test('an unregistered PayID type fails as a handled payments error, not a TypeError', async () => {
    await expect(submitPayment({ ...ABN_PAYMENT, payIdType: 'acn' })).rejects.toMatchObject({
      name: 'PaymentAddressingError',
      code: 'PAYID_ADDRESSING_UNSUPPORTED',
      statusCode: 422,
      operationsQueue: PAYMENT_OPERATIONS_QUEUE,
    });

    await expect(submitPayment({ ...ABN_PAYMENT, payIdType: 'acn' })).rejects.not.toBeInstanceOf(TypeError);

    expect(incrementMetric).toHaveBeenCalledWith('cba_payment.addressing_unsupported', expect.objectContaining({
      route: '/api/cba/payment',
      payIdType: 'acn',
      queue: PAYMENT_OPERATIONS_QUEUE,
    }));
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('an inherited Object.prototype key is not treated as a registered PayID type', async () => {
    await expect(submitPayment({ ...ABN_PAYMENT, payIdType: 'toString' })).rejects.toMatchObject({
      name: 'PaymentAddressingError',
      code: 'PAYID_ADDRESSING_UNSUPPORTED',
      statusCode: 422,
    });
  });

  test('email and mobile PayID payments still settle', async () => {
    const email = await submitPayment({
      ...ABN_PAYMENT,
      payId: 'accounts@sunriseplumbing.com.au',
      payIdType: 'email',
    });
    expect(email.payeeName).toBe('Sunrise Plumbing Pty Ltd (Email PayID)');

    const mobile = await submitPayment({
      ...ABN_PAYMENT,
      payId: '0412 345 678',
      payIdType: 'mobile',
    });
    expect(mobile.payeeName).toBe('Sunrise Plumbing Pty Ltd (Mobile PayID)');
  });

  test('validation failures are unchanged and raise no alert', async () => {
    await expect(submitPayment({ ...ABN_PAYMENT, payIdType: '' })).rejects.toMatchObject({
      name: 'ValidationError',
      statusCode: 400,
    });
    await expect(submitPayment({ ...ABN_PAYMENT, amount: 25000 })).rejects.toMatchObject({
      name: 'ValidationError',
      statusCode: 400,
    });

    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});
