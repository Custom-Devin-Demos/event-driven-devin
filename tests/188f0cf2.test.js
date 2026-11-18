jest.mock('../app/services/devin-session', () => ({ createSessionAndAlert: jest.fn().mockResolvedValue({}) }));
jest.mock('../app/telemetry/logger', () => ({ info: jest.fn(), error: jest.fn() }));
jest.mock('../app/telemetry/datadog', () => ({ incrementMetric: jest.fn(), recordTiming: jest.fn() }));
jest.mock('../app/telemetry/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
const { overview, processClaim, resetClaims } = require('../app/services/verticals/188f0cf2');
const { createSessionAndAlert } = require('../app/services/devin-session');
beforeEach(() => { resetClaims(); jest.clearAllMocks(); });
test('opening account has three services and no claims or alerts', () => {
  expect(overview().schedule).toHaveLength(3);
  expect(overview().pickups).toHaveLength(3);
  expect(overview().claims).toEqual([]);
  expect(overview().failed).toBe(false);
  expect(createSessionAndAlert).not.toHaveBeenCalled();
});
test('completed stop produces a return-pickup request and credit', async () => {
  expect(await processClaim({ container: 'Trash', date: '2026-11-17' })).toMatchObject({ success: true, serviceCredit: 6.25 });
  expect(createSessionAndAlert).not.toHaveBeenCalled();
});
test('missing dispatch record is a validation error without alert', async () => {
  await expect(processClaim({ container: 'Trash', date: '2026-11-01' })).rejects.toMatchObject({ statusCode: 422 });
  expect(createSessionAndAlert).not.toHaveBeenCalled();
});
test('incomplete tablet exception fails on submission and reset restores state without changing evidence', async () => {
  const input = { container: 'Recycling', date: '2026-11-17', devinOrgId: 'org-test' };
  await expect(processClaim(input)).rejects.toThrow("Cannot read properties of null (reading 'code')");
  expect(overview().failed).toBe(true);
  expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({ service: '188f0cf2-api', devinOrgId: 'org-test' }));
  expect(createSessionAndAlert.mock.calls[0][0]).not.toHaveProperty('customer');
  expect(resetClaims()).toEqual({ success: true, cleared: 1, status: 'ready' });
  expect(overview().claims).toEqual([]);
  await expect(processClaim(input)).rejects.toThrow(TypeError);
  expect(createSessionAndAlert).toHaveBeenCalledTimes(2);
});
