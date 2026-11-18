jest.mock('../app/services/devin-session', () => ({ createSessionAndAlert: jest.fn().mockResolvedValue({}) }));
jest.mock('../app/telemetry/logger', () => ({ info: jest.fn(), error: jest.fn() }));
jest.mock('../app/telemetry/datadog', () => ({ incrementMetric: jest.fn(), recordTiming: jest.fn() }));
jest.mock('../app/telemetry/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
const { overview, processClaim, resetClaims } = require('../app/services/verticals/188f0cf2');
const { createSessionAndAlert } = require('../app/services/devin-session');
beforeEach(() => { resetClaims(); jest.clearAllMocks(); });
test('opening account lists sites and KPIs with no claims or alerts', () => {
  expect(overview().sites).toHaveLength(5);
  expect(overview().kpis).toHaveLength(4);
  expect(overview().claims).toEqual([]);
  expect(overview().failed).toBe(false);
  expect(createSessionAndAlert).not.toHaveBeenCalled();
});
test('completed stop produces a return-pickup request and credit', async () => {
  expect(await processClaim({ siteId: 'NH-004', service: 'Front-load 8 yd', date: '2026-11-17' })).toMatchObject({ success: true, serviceCredit: 185 });
  expect(createSessionAndAlert).not.toHaveBeenCalled();
});
test('missing dispatch record is a validation error without alert', async () => {
  await expect(processClaim({ siteId: 'NH-004', service: 'Front-load 8 yd', date: '2026-11-01' })).rejects.toMatchObject({ statusCode: 422 });
  expect(createSessionAndAlert).not.toHaveBeenCalled();
});
test('incomplete tablet exception fails on submission and reset restores state without changing evidence', async () => {
  const input = { siteId: 'NH-001', service: 'Front-load 8 yd', date: '2026-11-17', devinOrgId: 'org-test' };
  await expect(processClaim(input)).rejects.toThrow("Cannot read properties of null (reading 'code')");
  expect(overview().failed).toBe(true);
  expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({ service: '188f0cf2-api', devinOrgId: 'org-test' }));
  expect(createSessionAndAlert.mock.calls[0][0]).not.toHaveProperty('customer');
  expect(resetClaims()).toEqual({ success: true, cleared: 1, status: 'ready' });
  expect(overview().claims).toEqual([]);
  await expect(processClaim(input)).rejects.toThrow(TypeError);
  expect(createSessionAndAlert).toHaveBeenCalledTimes(2);
});
