jest.mock('../app/telemetry/logger', () => ({ info: jest.fn(), error: jest.fn() }));
jest.mock('../app/telemetry/datadog', () => ({ incrementMetric: jest.fn(), recordTiming: jest.fn() }));
jest.mock('../app/telemetry/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({
    destination: jest.requireActual('../app/services/alert-destination').currentAlertDestination(),
  })),
}));
const service = require('../app/services/verticals/9663ef9a');
const { adaptTelemetry } = require('../app/services/verticals/9663ef9a-health-rules');
const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const logger = require('../app/telemetry/logger');
const { runWithAlertDestination } = require('../app/services/alert-destination');

beforeEach(() => { service.resetRollout(); jest.clearAllMocks(); });

test('overview is clean and contains ten trucks with four autonomous assets', () => {
  const overview = service.getOverview();
  expect(overview.fleet).toHaveLength(10);
  expect(overview.fleet.filter(t => t.autonomous)).toHaveLength(4);
  expect(overview).toMatchObject({ status: 'Ready', error: null, kpis: { running: 10, stopped: 0, availability: 100 } });
  expect(overview.fleet.every(truck => truck.status === 'Running')).toBe(true);
  expect(overview.targets).toEqual(['HT-220', 'HT-221', 'HT-222', 'HT-223']);
  expect(createSessionAndAlert).not.toHaveBeenCalled();
});

test('adapter returns vehicle speed including a stationary truck', () => {
  expect(adaptTelemetry({ truckId: 'HT-220', groundSpeedKph: 18 })).toEqual({ truckId: 'HT-220', speedKph: 18 });
  expect(adaptTelemetry({ truckId: 'HT-220', groundSpeedKph: 0 }).speedKph).toBe(0);
});

test('adapter rejects unavailable telemetry', () => {
  expect(() => adaptTelemetry({})).toThrow();
});

test.each([undefined, 'slack', 'teams'])('rollout preserves untargeted trucks and reset restores Ready with destination %p', async destination => {
  const initial = service.getOverview();
  let result;
  try {
    result = await runWithAlertDestination(destination, () => service.runRollout({ devinEmail: 'operator@example.com' }));
  } catch (error) {
    expect(error.cause).toBeInstanceOf(Error);
    const cause = { name: error.cause.name, message: error.cause.message, stack: error.cause.stack };
    expect(cause.stack).toEqual(expect.any(String));
    expect(logger.error).toHaveBeenCalledWith('OEM firmware rollout failed', expect.objectContaining({ cause }));
    expect(Sentry.captureException).toHaveBeenCalledWith(error, expect.objectContaining({ extra: expect.objectContaining({ cause }) }));
    expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({ extra: expect.objectContaining({ cause }) }));
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.errorValue).toContain(error.message);
    expect(alert.errorValue).toContain(`${cause.name}: ${cause.message}`);
    expect(alert.errorValue).toContain(cause.stack.split('\n')[1]);
    expect(service.getOverview().error).toBe(error.message);
    expect(service.getOverview()).toMatchObject({ status: 'Failed', kpis: { running: 6, stopped: 4 } });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ tags: { service: '9663ef9a-api', alert_path: 'instant' } }));
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({ service: '9663ef9a-api', devinEmail: 'operator@example.com' }));
    expect(createSessionAndAlert.mock.calls[0][0]).not.toHaveProperty('slackMemberId');
    expect(createSessionAndAlert.mock.calls[0][0]).not.toHaveProperty('customer');
    await expect(createSessionAndAlert.mock.results[0].value).resolves.toEqual({ destination: 'teams' });
  }
  if (result) {
    expect(result).toMatchObject({ success: true, status: 'Completed', kpis: { running: 10, stopped: 0 } });
    expect(result.fleet.filter(truck => truck.autonomous).every(truck => truck.firmware === '4.8')).toBe(true);
  }
  expect(service.getOverview().fleet.filter(truck => !truck.autonomous)).toEqual(initial.fleet.filter(truck => !truck.autonomous));
  expect(service.resetRollout()).toMatchObject({ success: true, ...initial });
  expect(service.getOverview()).toEqual(initial);
});
