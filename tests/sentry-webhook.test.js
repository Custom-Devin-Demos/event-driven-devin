/* global describe, expect, test */

const {
  applyCustomerIdentity,
  extractAlertData,
  isInstantPathEvent,
} = require('../app/routes/sentry-webhook');

describe('Sentry customer identity mapping', () => {
  test.each([
    { tags: [['alert_path', 'instant']] },
    { tags: [{ key: 'alert_path', value: 'instant' }] },
    { tags: [{ alert_path: 'instant' }] },
  ])('recognizes instant-path tag shape %p', (alertData) => {
    expect(isInstantPathEvent(alertData)).toBe(true);
  });

  test('recognizes Misfits Market events tagged as instant-path alerts', () => {
    expect(isInstantPathEvent({
      tags: [['alert_path', 'instant'], ['service', 'customer-77560b41-checkout']],
      culprit: 'app/services/verticals/77560b41.js — applySubstitutions',
    })).toBe(true);
  });

  test('recognizes tagless Misfits Market issue webhooks by culprit module path', () => {
    expect(isInstantPathEvent({
      issueTitle: "TypeError: Cannot read properties of undefined (reading 'sku')",
      culprit: 'app/services/verticals/77560b41.js — applySubstitutions',
      tags: [],
    })).toBe(true);
  });

  test.each([
    { tags: [['alert_path', 'latency']] },
    { tags: [{ key: 'alert_path', value: 'latency' }] },
    { tags: [{ alert_path: 'latency' }] },
  ])('recognizes latency-path tag shape %p', (alertData) => {
    expect(isInstantPathEvent(alertData)).toBe(true);
  });

  test('does not recognize a different alert path', () => {
    expect(isInstantPathEvent({ tags: [['alert_path', 'webhook']] })).toBe(false);
  });

  test.each([
    'reportLatencyBreach(app/services/verticals/ef51d258)',
    'reportLatencyBreach(app/services/verticals/f887d0be)',
    'reportLatencyBreach(app/services/verticals/d708940c)',
    'reportLatencyBreach(app/services/verticals/04525b56)',
    'reportLatencyBreach(app/services/verticals/fd043af6)',
    'reportLatencyBreach(app/services/verticals/fe97a788)',
    'reportLatencyBreach(app/services/verticals/37b90289)',
    'reportLatencyBreach(app/services/verticals/8f970d35)',
    'reportLatencyBreach(app/services/verticals/924f5ec9)',
    'reportLatencyBreach(app/services/verticals/2ecabf0c)',
    'reportLatencyBreach(app/services/verticals/485ddc93)',
    'reportLatencyBreach(app/services/verticals/b1e1bd35)',
  ])('recognizes a tagless latency-breach issue webhook by culprit %p', (culprit) => {
    expect(isInstantPathEvent({ culprit, tags: [] })).toBe(true);
  });

  test('does not treat an unrelated culprit with another alert path as direct-alerted', () => {
    expect(isInstantPathEvent({
      culprit: 'verifyIdentity(app.services.verticals.b25c3f24)',
      tags: [['alert_path', 'other']],
    })).toBe(false);
  });

  test.each([
    'LatencyBudgetExceeded: POST /api/ef51d258/availability took 9039ms (budget 3000ms)',
    'LatencyBudgetExceeded: POST /api/f887d0be/enquiry took 9540ms (budget 3000ms)',
    'LatencyBudgetExceeded: POST /api/d708940c/order-preview took 9120ms (budget 3000ms)',
    'LatencyBudgetExceeded: POST /api/04525b56/inspection-scan took 7000ms (budget 3000ms)',
    'LatencyBudgetExceeded: POST /api/fd043af6/program-match took 7120ms (budget 3000ms)',
    'LatencyBudgetExceeded: POST /api/fe97a788/query took 7040ms (budget 3000ms)',
    'LatencyBudgetExceeded: POST /api/37b90289/case-search took 7040ms (budget 3000ms)',
    'LatencyBudgetExceeded: POST /api/8f970d35/compliance-check took 7010ms (budget 3000ms)',
    'LatencyBudgetExceeded: POST /api/924f5ec9/member-lookup took 7040ms (budget 3000ms)',
    'LatencyBudgetExceeded: POST /api/2ecabf0c/specialist-match took 7020ms (budget 3000ms)',
    'LatencyBudgetExceeded: POST /api/485ddc93/obituary-search took 7060ms (budget 3000ms)',
    'LatencyBudgetExceeded: POST /api/b1e1bd35/pay-run-preview took 7030ms (budget 3000ms)',
  ])('recognizes a latency-breach issue webhook by error type regardless of culprit %p', (title) => {
    const alertData = extractAlertData({
      action: 'created',
      data: {
        issue: {
          id: '1',
          title,
          culprit: 'processImmediate(node:internal/timers)',
          metadata: { type: 'LatencyBudgetExceeded' },
        },
      },
    });
    expect(alertData.errorType).toBe('LatencyBudgetExceeded');
    expect(isInstantPathEvent(alertData)).toBe(true);
  });

  test('does not skip a LatencyBudgetExceeded issue from an unrelated route', () => {
    const alertData = extractAlertData({
      action: 'created',
      data: {
        issue: {
          id: '3',
          title: 'LatencyBudgetExceeded: GET /api/other/report took 5000ms',
          culprit: 'processImmediate(node:internal/timers)',
          metadata: { type: 'LatencyBudgetExceeded' },
        },
      },
    });
    expect(isInstantPathEvent(alertData)).toBe(false);
  });

  test('recognizes a latency-breach event_alert webhook by its tags', () => {
    const alertData = extractAlertData({
      action: 'triggered',
      data: {
        event: {
          title: 'LatencyBudgetExceeded: POST /api/f887d0be/enquiry took 9540ms (budget 3000ms)',
          culprit: 'x',
          tags: [['alert_path', 'latency'], ['service', 'customer-f887d0be-enquiry']],
        },
      },
    });
    expect(isInstantPathEvent(alertData)).toBe(true);
  });

  test('does not treat a regular vertical TypeError issue webhook as direct-alerted', () => {
    const alertData = extractAlertData({
      action: 'created',
      data: {
        issue: {
          id: '2',
          title: "TypeError: Cannot read properties of undefined (reading 'x')",
          culprit: 'fn(app/services/verticals/b25c3f24)',
          metadata: { type: 'TypeError' },
        },
      },
    });
    expect(isInstantPathEvent(alertData)).toBe(false);
  });

  test('recognizes a tagless Rippling issue webhook by its culprit module path', () => {
    expect(isInstantPathEvent({
      issueTitle: "TypeError: Cannot read properties of undefined (reading 'withholdingRate')",
      culprit: 'computeWithholding(app.services.verticals.a7fb8819)',
      tags: [],
    })).toBe(true);
  });

  test('recognizes a tagless Gusto issue webhook by its culprit module path', () => {
    expect(isInstantPathEvent({
      issueTitle: "TypeError: Cannot read properties of undefined (reading 'employerRate')",
      culprit: 'computeCompanyDebit(app.services.verticals.f8555891)',
      tags: [],
    })).toBe(true);
  });

  test('recognizes a tagless athletic retail issue webhook by its culprit module path', () => {
    expect(isInstantPathEvent({
      issueTitle: "TypeError: Cannot read properties of undefined (reading 'pointsMultiplier')",
      culprit: 'applyMemberBenefits(app.services.verticals.5275ac3e)',
      tags: [],
    })).toBe(true);
  });

  test('recognizes a tagless fleet health issue webhook by its culprit module path', () => {
    expect(isInstantPathEvent({
      culprit: 'app/services/verticals/a693dab5.js — normalizeSnapshots',
      tags: [],
    })).toBe(true);
  });

  test('recognizes a tagless critical fault sweep issue webhook by its culprit module path', () => {
    expect(isInstantPathEvent({
      culprit: 'app/services/verticals/0eda990f.js — runFaultSweep',
      tags: [],
    })).toBe(true);
  });

  test.each([
    'buildCoverageSummary(app.services.verticals.7c6a6ef9)',
    'POST /api/7c6a6ef9/coverage',
  ])('recognizes a tagless enGen coverage issue webhook by culprit %p', (culprit) => {
    expect(isInstantPathEvent({ culprit, tags: [] })).toBe(true);
  });

  test.each([
    'estimateVisitCost(app.services.verticals.7c6a6ef9)',
    'POST /api/7c6a6ef9/cost-estimate',
  ])('does not treat a tagless enGen cost-estimate issue webhook as instant path %p', (culprit) => {
    expect(isInstantPathEvent({ culprit, tags: [] })).toBe(false);
  });

  test('recognizes a tagless NPP payments issue webhook by its culprit module path', () => {
    expect(isInstantPathEvent({
      culprit: 'app/services/verticals/4157609f.js — initiatePayment',
      tags: [],
    })).toBe(true);
  });

  test.each([
    'app/services/verticals/1182181f.js — decodeSamples',
    'app/services/verticals/26af2083.js — decodeJ1939',
  ])('recognizes a tagless Talon ingest issue webhook by culprit %p', (culprit) => {
    expect(isInstantPathEvent({ culprit, tags: [] })).toBe(true);
  });

  test('does not recognize a tagless issue webhook from another vertical', () => {
    expect(isInstantPathEvent({
      culprit: 'verifyIdentity(app.services.verticals.b25c3f24)',
      tags: [],
    })).toBe(false);
  });

  test('maps Zelle service tags to the Bank of America customer identity', () => {
    const alertData = applyCustomerIdentity({
      issueTitle: 'LimitExceededError: Amount exceeds daily limit',
      service: 'customer-6f43e66c-zelle-send',
      project: 'event-driven-devin',
      release: 'acme-checkout@1.0.2',
      tags: [
        ['service', 'customer-6f43e66c-zelle-send'],
        ['route', '/api/6f43e66c/send'],
      ],
    });

    expect(alertData).toMatchObject({
      customer: '6f43e66c',
      verticalLabel: 'Consumer Zelle Send',
      service: 'customer-6f43e66c-zelle-send',
      project: 'event-driven-devin',
      release: 'customer-6f43e66c-zelle-send@1.0.0',
    });
    expect(alertData.tags).toEqual(expect.arrayContaining([
      { key: 'customer', value: '6f43e66c' },
      { key: 'service', value: 'customer-6f43e66c-zelle-send' },
      { key: 'route', value: '/api/6f43e66c/send' },
      { key: 'scenario', value: 'zelle-send' },
    ]));
  });

  test('maps Flutter portal service tags to the GE customer identity and Flutter directive', () => {
    const alertData = applyCustomerIdentity({
      issueTitle: 'Null check operator used on a null value',
      culprit: 'buildEngineCoverage',
      project: 'ge-customer-portal',
      release: 'ge-customer-portal@1.0.0',
      tags: [
        ['service', 'customer-5b992ae7-portal'],
        ['platform', 'linux'],
        ['screen', 'inquiry'],
      ],
    });

    expect(alertData).toMatchObject({
      customer: '5b992ae7',
      verticalLabel: 'GE Aerospace Customer Portal',
      service: 'customer-5b992ae7-portal',
      project: 'ge-customer-portal',
      release: 'ge-customer-portal@1.0.0',
    });
    expect(alertData.promptAppendix).toContain('github.com/Custom-Devin-Demos/ge-customer-portal');
    expect(alertData.promptAppendix).toContain('flutter test');
    expect(alertData.promptAppendix).toMatch(/Linux, Windows and macOS/);
    expect(alertData.tags).toEqual(expect.arrayContaining([
      { key: 'customer', value: 'customer-5b992ae7-portal' },
      { key: 'service', value: 'customer-5b992ae7-portal' },
      { key: 'scenario', value: 'technical-inquiry' },
      ['platform', 'linux'],
    ]));
  });

  test('maps Splash mobile service tags to the Splash customer identity and mobile-repo directive', () => {
    const alertData = applyCustomerIdentity({
      issueTitle: "TypeError: Cannot read properties of undefined (reading 'multiplier')",
      culprit: 'submitSlip',
      tags: [
        ['service', 'customer-3aa9fa04-mobile'],
        ['platform', 'android'],
        ['slate', 'MNF'],
      ],
    });

    expect(alertData).toMatchObject({
      customer: '3aa9fa04',
      verticalLabel: 'Splash Sports Mobile',
      service: 'customer-3aa9fa04-mobile',
      project: 'splash-sports-mobile',
      release: 'splash-sports-mobile@1.0.0',
    });
    expect(alertData.promptAppendix).toContain('github.com/COG-GTM/splash-sports-mobile');
    expect(alertData.tags).toEqual(expect.arrayContaining([
      { key: 'customer', value: 'customer-3aa9fa04-mobile' },
      { key: 'service', value: 'customer-3aa9fa04-mobile' },
      { key: 'scenario', value: 'nfl-primetime-entry' },
      ['slate', 'MNF'],
    ]));
  });

  test('leaves the server-side GE inquiry alert on the Node directive', () => {
    const alertData = applyCustomerIdentity({
      issueTitle: 'TypeError: Cannot read properties of undefined',
      service: 'customer-5b992ae7-inquiry',
      tags: [['service', 'customer-5b992ae7-inquiry']],
    });

    expect(alertData.promptAppendix).toBeUndefined();
    expect(alertData.verticalLabel).toBeUndefined();
  });
});
