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
const { estimateVisitCost } = require('../app/services/verticals/7c6a6ef9');

describe('enGen visit cost estimate (7c6a6ef9)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
    incrementMetric.mockClear();
  });

  test('a PPO member is quoted against the PPO deductible', async () => {
    const result = await estimateVisitCost({ memberId: 'HM-20481973', serviceId: 'specialist' });

    expect(result.status).toBe('quoted');
    expect(result.planType).toBe('ppo');
    expect(result.memberPays).toBe(320);
    expect(result.deductibleRemaining).toBe(760);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('preventive care is quoted at $0 for every plan', async () => {
    const result = await estimateVisitCost({ memberId: 'HM-20559841', serviceId: 'preventive-visit' });

    expect(result.memberPays).toBe(0);
    expect(result.planPays).toBe(210);
  });

  test('an HDHP member is silently quoted the PPO copay under the planted network-default fallback', async () => {
    const result = await estimateVisitCost({ memberId: 'HM-20487562', serviceId: 'specialist' });

    expect(result.status).toBe('quoted');
    expect(result.planType).toBe('ppo');
    expect(result.memberPays).toBe(30);
    expect(result.deductibleMet).toBe(true);
    expect(incrementMetric).toHaveBeenCalledWith('cost_estimate.quoted', expect.objectContaining({
      plan: 'ppo',
      memberId: 'HM-20487562',
    }));
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('an EPO member whose deductible is met is silently told it is not', async () => {
    const result = await estimateVisitCost({ memberId: 'HM-20612308', serviceId: 'specialist' });

    expect(result.planType).toBe('ppo');
    expect(result.deductibleMet).toBe(false);
    expect(result.deductibleRemaining).toBe(250);
    expect(result.memberPays).toBe(264);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test.each([
    ['unknown member', { memberId: 'HM-00000000', serviceId: 'specialist' }, 'MemberNotFoundError', 404, 'MEMBER_NOT_FOUND'],
    ['unknown service', { memberId: 'HM-20481973', serviceId: 'dental' }, 'ValidationError', 400, 'UNKNOWN_SERVICE'],
  ])('%s is rejected without paging anyone', async (_caseName, data, name, statusCode, code) => {
    await expect(estimateVisitCost(data)).rejects.toMatchObject({ name, statusCode, code });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});
