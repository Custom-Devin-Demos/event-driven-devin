/* global describe, expect, jest, test */

jest.mock('../../telemetry/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../../telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));
jest.mock('../../telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
}));
jest.mock('../devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve()),
}));

const { processDemoRequest } = require('./8c0e99b1');

describe('CloudSuite demo request service (8c0e99b1)', () => {
  test('resolves the reported title-cased industry and builds a deployment plan', async () => {
    const result = await processDemoRequest({
      industry: 'Industrial Manufacturing',
      region: 'us-east',
      modules: ['erp', 'scm'],
    });

    expect(result.suite).toBe('CloudSuite Industrial Enterprise');
    expect(result.plan).toMatchObject({
      suiteKey: 'industrial-manufacturing',
      region: 'us-east',
      modules: ['erp', 'scm'],
    });
  });

  test('rejects an unknown industry without a destructuring TypeError', async () => {
    await expect(processDemoRequest({
      industry: 'unknown-industry',
      region: 'us-east',
      modules: [],
    })).rejects.toThrow('Unsupported industry: unknown-industry');
  });
});
