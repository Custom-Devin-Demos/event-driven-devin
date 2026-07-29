const { describe, test, expect } = require('@jest/globals');
const {
  processDemoRequest,
  resolveSuite,
  buildDeploymentPlan,
} = require('./8c0e99b1');

describe('CloudSuite demo request service', () => {
  test('processes the production Industrial Manufacturing request', async () => {
    const result = await processDemoRequest({
      industry: 'Industrial Manufacturing',
      region: 'us-east',
      modules: ['erp', 'scm'],
    });

    expect(result.suite).toBe('CloudSuite Industrial Enterprise');
    expect(result.plan.suiteKey).toBe('industrial-manufacturing');
    expect(result.plan.modules).toEqual(['erp', 'scm']);
  });

  test('normalizes whitespace and casing for known industries', () => {
    const resolved = resolveSuite('  INDUSTRIAL   MANUFACTURING ');

    expect(resolved.key).toBe('industrial-manufacturing');
    expect(resolved.suite.label).toBe('CloudSuite Industrial Enterprise');
  });

  test('reports unknown industries without a destructuring TypeError', () => {
    expect(() => buildDeploymentPlan(resolveSuite('Unknown Industry'), 'us-east', [])).toThrow(
      'Unknown CloudSuite industry: unknown-industry',
    );
  });
});
