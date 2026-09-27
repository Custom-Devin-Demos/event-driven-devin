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
const { sendMessage } = require('../app/services/verticals/ps');

describe('PerfectServe secure messaging (ps)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('valid send fails with a TypeError in routing and raises an alert', async () => {
    await expect(sendMessage({
      participantIds: ['fiscus-wayne'],
      messageType: 'general',
      encounterId: 'enc-charles',
      message: 'PT feeling ill',
    })).rejects.toThrow(TypeError);

    await expect(sendMessage({
      participantIds: ['fiscus-wayne'],
      messageType: 'general',
      encounterId: 'enc-charles',
      message: 'PT feeling ill',
    })).rejects.toThrow(/reading 'push'/);

    expect(Sentry.captureException).toHaveBeenCalled();
    expect(createSessionAndAlert).toHaveBeenCalledTimes(2);

    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('ps');
    expect(alert.slackMemberId).toBe('U0BQZBHCNMA');
    expect(alert.errorType).toBe('TypeError');
    expect(alert.culprit).toContain('routeToRecipients');
  });

  test('different type, two participants and no encounter still hit the same TypeError', async () => {
    await expect(sendMessage({
      participantIds: ['fiscus-wayne', 'alvarez-antonio'],
      messageType: 'critical_lab',
      message: 'K+ 6.8, please review',
    })).rejects.toThrow(TypeError);

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert.mock.calls[0][0].extra.participants).toEqual([
      'Fiscus, Wayne',
      'Alvarez, Antonio',
    ]);
  });

  test('empty participants returns a 400 ValidationError with no alert', async () => {
    await expect(sendMessage({
      participantIds: [],
      messageType: 'general',
      message: 'hello',
    })).rejects.toMatchObject({
      name: 'ValidationError',
      statusCode: 400,
      code: 'NO_PARTICIPANTS',
    });

    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('unknown message type returns a 400 ValidationError with no alert', async () => {
    await expect(sendMessage({
      participantIds: ['fiscus-wayne'],
      messageType: 'fax',
      message: 'hello',
    })).rejects.toMatchObject({
      name: 'ValidationError',
      statusCode: 400,
      code: 'INVALID_MESSAGE_TYPE',
    });

    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});
