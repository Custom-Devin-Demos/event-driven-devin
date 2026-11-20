jest.mock('../app/telemetry/logger', () => ({ info: jest.fn(), error: jest.fn() }));
jest.mock('../app/telemetry/datadog', () => ({ incrementMetric: jest.fn(), recordTiming: jest.fn() }));
jest.mock('../app/telemetry/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({
    destination: jest.requireActual('../app/services/alert-destination').currentAlertDestination(),
  })),
}));
const service = require('../app/services/verticals/9663ef9a');
const { normalizeEvent } = require('../app/services/verticals/9663ef9a-health-rules');
const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { runWithAlertDestination } = require('../app/services/alert-destination');

beforeEach(() => { service.resetSweep(); jest.clearAllMocks(); });

test('overview is clean and contains ten trucks with four autonomous assets', () => {
  const overview = service.getOverview();
  expect(overview.fleet).toHaveLength(10);
  expect(overview.fleet.filter(t => t.autonomous)).toHaveLength(4);
  expect(overview).toMatchObject({ status: 'Ready', error: null, events: [], workOrders: [] });
  expect(createSessionAndAlert).not.toHaveBeenCalled();
});

test('flat samples retain diagnostic display codes', () => {
  expect(normalizeEvent({ version: 2, spn: 110, fmi: 0 }).code).toBe('SPN 110 FMI 0');
});

test.each([undefined, 'slack', 'teams'])('reset returns the clean Ready state after a sweep attempt with destination %p', async destination => {
  try {
    await runWithAlertDestination(destination, () => service.runSweep({ devinEmail: 'operator@example.com' }));
  } catch {
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ tags: { service: '9663ef9a-api', alert_path: 'instant' } }));
    expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({ service: '9663ef9a-api', devinEmail: 'operator@example.com' }));
    expect(createSessionAndAlert.mock.calls[0][0]).not.toHaveProperty('slackMemberId');
    expect(createSessionAndAlert.mock.calls[0][0]).not.toHaveProperty('customer');
    await expect(createSessionAndAlert.mock.results[0].value).resolves.toEqual({ destination: 'teams' });
  }
  expect(service.resetSweep()).toMatchObject({ status: 'Ready', error: null, events: [], workOrders: [] });
  expect(service.getOverview()).toMatchObject({ status: 'Ready', error: null, events: [], workOrders: [] });
});
