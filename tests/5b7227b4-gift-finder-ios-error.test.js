jest.mock('../app/services/devin-session', () => {
  const actual = jest.requireActual('../app/services/devin-session');
  return {
    buildPrompt: actual.buildPrompt,
    createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
  };
});

jest.mock('../app/services/devin-api', () => ({
  listOrgUsers: jest.fn(() => Promise.resolve([])),
  listEnterpriseAdmins: jest.fn(() => Promise.resolve([])),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: {
    captureException: jest.fn(),
    withScope: jest.fn((callback) => {
      const scope = { setTransactionName: jest.fn() };
      callback(scope);
      return scope;
    }),
  },
  initSentry: jest.fn(),
}));

jest.mock('../app/telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));

const originalEnvironment = {
  GIFT_FINDER_IOS_SESSION_PLATFORM: process.env.GIFT_FINDER_IOS_SESSION_PLATFORM,
  DEVIN_ORG_ID: process.env.DEVIN_ORG_ID,
  DEVIN_ORG_ID_5B7227B4: process.env.DEVIN_ORG_ID_5B7227B4,
};
delete process.env.GIFT_FINDER_IOS_SESSION_PLATFORM;
delete process.env.DEVIN_ORG_ID_5B7227B4;
process.env.DEVIN_ORG_ID = 'org_69IXJFLrljx8zSAw';

const express = require('express');
const { buildPrompt, createSessionAndAlert } = require('../app/services/devin-session');
const { listOrgUsers, listEnterpriseAdmins } = require('../app/services/devin-api');
const { Sentry } = require('../app/telemetry/sentry');
const { incrementMetric } = require('../app/telemetry/datadog');
const { NORDSTROM_ORG_ID } = require('../app/services/verticals/5b7227b4');
const {
  APP_CULPRIT,
  APP_DIR,
  APP_PROJECT,
  APP_REMEDIATION_DIRECTIVE,
  APP_RELEASE,
  APP_REPO,
  APP_REPO_NAME,
  APP_SCENARIO,
  APP_SERVICE,
  APP_SOURCE_PREFIX,
  APP_STAGE,
  GIFT_FINDER_IOS_SESSION_PLATFORM,
  IOS_ERROR_PATH,
  customerForOrg,
  isAppReport,
  reportAppFailure,
  resolveUserIdByEmail,
} = require('../app/services/verticals/5b7227b4-gift-finder-ios');
const router = require('../app/routes/verticals/5b7227b4-gift-finder-ios');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');

const HUB_ORG_ID = 'org_69IXJFLrljx8zSAw';
const FORBIDDEN_LANGUAGE = ['planted', 'simulated', 'simulation', 'synthetic', 'intentional', 'demo bug', 'injected'];

const APP_REPORT = {
  source: `${APP_SOURCE_PREFIX}ios`,
  service: APP_SERVICE,
  release: APP_RELEASE,
  environment: 'prod',
  reference: 'NORD-GF-3F9A1C',
  platform: 'ios',
  osVersion: '27.0.0',
  device: 'iPhone',
  appVersion: '1.1.0',
  appName: 'Nordstrom Gift Finder',
  appRepo: APP_REPO_NAME,
  appDir: APP_DIR,
  screen: 'bag',
  action: 'reserve_pickup',
  stage: APP_STAGE,
  recipient: 'partner',
  errorType: 'ReservationError.missingFulfillmentProfile',
  errorMessage: "No fulfillment profile is configured for recipient 'partner'; the gift hold could not be submitted",
  stackTrace: [
    'ReservationService.reserve(recipient:pickupItems:shippingItems:giftWrap:giftMessage:profiles:) (apps/nordstrom-gift-finder/App/Services/ReservationService.swift)',
    'GiftStore.checkout() (apps/nordstrom-gift-finder/App/Store/GiftStore.swift)',
    'BagView.footer reserve-pickup (apps/nordstrom-gift-finder/App/Views/BagView.swift)',
  ].join('\n'),
  reproduction: 'Launch the app and tap Start the gift finder → Recipient: Partner → Interests: style, accessories → Budget: 150-300; Deadline: today → Add any pick to the bag, open the bag, tap the primary reservation button',
  context: {
    recipient: 'partner',
    interests: 'style,accessories',
    budget: '150-300',
    deadline: 'today',
    bagItems: 'coach-pebbled-crossbody',
    pickupCount: 1,
    shippingCount: 0,
    giftWrap: 'yes',
    giftMessage: 'present',
    fulfillment: 'pickup',
    nested: { dropped: true },
  },
  devinEmail: 'shahmir.masood@cognition.ai',
};

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

async function post(app, body, headers = {}) {
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}${IOS_ERROR_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

afterAll(() => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('Nordstrom Gift Finder iOS final-reservation failure report', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    router._resetReportCap();
  });

  test('accepts a valid app report and requests the remediation session against COG-GTM/ios-demos', async () => {
    const response = await post(makeApp(), APP_REPORT);
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ received: true, status: 'accepted', service: APP_SERVICE, sessionRequested: true });
    expect(response.body.reference).toMatch(/^[0-9a-f-]{36}$/);

    await flush();
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert).toMatchObject({
      issueTitle: `${APP_REPORT.errorType}: ${APP_REPORT.errorMessage}`,
      culprit: APP_CULPRIT,
      errorType: APP_REPORT.errorType,
      errorValue: APP_REPORT.errorMessage,
      service: APP_SERVICE,
      customer: 'default',
      project: APP_PROJECT,
      release: APP_RELEASE,
      sessionPlatform: 'macos',
      promptAppendix: APP_REMEDIATION_DIRECTIVE,
      devinEmail: APP_REPORT.devinEmail,
      level: 'error',
      environment: 'prod',
    });
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: IOS_ERROR_PATH },
      { key: 'service', value: APP_SERVICE },
      { key: 'recipient', value: 'partner' },
      { key: 'stage', value: APP_STAGE },
      { key: 'scenario', value: APP_SCENARIO },
      { key: 'alert_path', value: 'instant' },
    ]));
    expect(alert.extra).toMatchObject({
      clientReference: 'NORD-GF-3F9A1C',
      recipient: 'partner',
      stage: APP_STAGE,
      stackTrace: APP_REPORT.stackTrace,
      reproduction: APP_REPORT.reproduction,
      reporterEmail: APP_REPORT.devinEmail,
    });
    expect(alert.extra.context).toEqual({
      recipient: 'partner',
      interests: 'style,accessories',
      budget: '150-300',
      deadline: 'today',
      bagItems: 'coach-pebbled-crossbody',
      pickupCount: 1,
      shippingCount: 0,
      giftWrap: 'yes',
      giftMessage: 'present',
      fulfillment: 'pickup',
    });
  });

  test('the generated session prompt reads like a production incident and targets the Swift repo', async () => {
    await post(makeApp(), APP_REPORT);
    await flush();
    const alert = createSessionAndAlert.mock.calls[0][0];
    const prompt = buildPrompt(alert);

    expect(prompt).toContain('!sentry_investigation');
    expect(prompt).toContain(APP_REPORT.errorType);
    expect(prompt).toContain(APP_REPORT.errorMessage);
    expect(prompt).toContain(`github.com/${APP_REPO_NAME}`);
    expect(prompt).toContain(`${APP_DIR}/`);
    expect(prompt).toContain('Partner gift reservations are failing at final reservation');
    expect(prompt).toContain('Reproduction (iOS Simulator)');
    expect(prompt).toContain('Recipient: Partner');
    expect(prompt).toContain('Recipient: Mom');
    expect(prompt).toMatch(/root cause/i);
    expect(prompt).toMatch(/Add or update XCTest coverage/);
    expect(prompt).toContain('make test APP=nordstrom-gift-finder');
    expect(prompt).toMatch(/Open a pull request against `main` of `COG-GTM\/ios-demos`/);
    expect(prompt).not.toContain('Custom-Devin-Demos');
    expect(prompt).not.toContain('event-driven-demos-ios');
    expect(prompt).not.toContain('nordstrom-shopping-demo-app');
    expect(prompt).not.toContain('DEMO — DO NOT MERGE');

    const lower = prompt.toLowerCase();
    for (const word of FORBIDDEN_LANGUAGE) {
      expect(lower).not.toContain(word);
    }
  });

  test('the remediation directive itself is free of simulation language', () => {
    const lower = APP_REMEDIATION_DIRECTIVE.toLowerCase();
    for (const word of FORBIDDEN_LANGUAGE) expect(lower).not.toContain(word);
    expect(APP_REMEDIATION_DIRECTIVE).toContain(APP_REPO);
    expect(APP_REMEDIATION_DIRECTIVE).toContain('NORDSTROM_DISABLE_FAILURE_REPORTS=1');
  });

  test('captures the app error in Sentry with the instant-path tags and route transaction', async () => {
    await post(makeApp(), APP_REPORT);
    expect(Sentry.withScope).toHaveBeenCalledTimes(1);
    const scope = Sentry.withScope.mock.results[0].value;
    expect(scope.setTransactionName).toHaveBeenCalledWith(`POST ${IOS_ERROR_PATH}`);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [error, { tags, extra }] = Sentry.captureException.mock.calls[0];
    expect(error.name).toBe(APP_REPORT.errorType);
    expect(error.message).toBe(APP_REPORT.errorMessage);
    expect(error.stack).toContain('ReservationService.swift');
    expect(tags).toMatchObject({ service: APP_SERVICE, recipient: 'partner', stage: APP_STAGE, alert_path: 'instant', scenario: APP_SCENARIO });
    expect(extra.context.nested).toBeUndefined();
    expect(incrementMetric).toHaveBeenCalledWith('gift_finder.reservation.failure', expect.objectContaining({ recipient: 'partner', errorClass: APP_REPORT.errorType }));
  });

  test('the webhook treats the bridge as an instant path so no second alert is raised', () => {
    expect(isInstantPathEvent({ culprit: `POST ${IOS_ERROR_PATH}` })).toBe(true);
    expect(isInstantPathEvent({ culprit: APP_CULPRIT })).toBe(true);
    expect(isInstantPathEvent({ culprit: 'unrelated/module.js' })).toBe(false);
  });

  test('rejects reports missing the source, service, errorType or recipient without alerting', async () => {
    const app = makeApp();
    const cases = [
      { ...APP_REPORT, source: 'nordstrom-shop/ios' },
      { ...APP_REPORT, service: 'customer-5b7227b4-mobile' },
      { ...APP_REPORT, errorType: '' },
      { ...APP_REPORT, recipient: undefined },
      {},
    ];
    for (const body of cases) {
      const response = await post(app, body);
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ received: false, status: 'rejected' });
    }
    await flush();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(isAppReport(APP_REPORT)).toBe(true);
    expect(isAppReport({ ...APP_REPORT, recipient: '  ' })).toBe(false);
  });

  test('answers the CORS preflight and includes CORS headers on rejection', async () => {
    const app = makeApp();
    const server = app.listen(0);
    const { port } = server.address();
    try {
      const preflight = await fetch(`http://127.0.0.1:${port}${IOS_ERROR_PATH}`, { method: 'OPTIONS' });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    const rejected = await post(app, {});
    expect(rejected.headers.get('access-control-allow-origin')).toBe('*');
  });

  test('throttles accepted reports after the per-route cap', async () => {
    const app = makeApp();
    for (let i = 0; i < 10; i += 1) {
      expect((await post(app, APP_REPORT)).status).toBe(202);
    }
    const throttled = await post(app, APP_REPORT);
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('retry-after')).toBe('600');
    await flush();
    expect(createSessionAndAlert).toHaveBeenCalledTimes(10);
  });

  test('clips oversized strings before they reach Sentry and the alert', async () => {
    await post(makeApp(), { ...APP_REPORT, errorMessage: 'x'.repeat(2000), stackTrace: 'y'.repeat(10000), recipient: 'z'.repeat(100) });
    await flush();
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.errorValue).toHaveLength(512);
    expect(alert.extra.stackTrace).toHaveLength(4000);
    expect(alert.extra.recipient).toHaveLength(32);
  });

  test('routes to the Nordstrom customer only when the report carries the Nordstrom org', async () => {
    expect(customerForOrg(undefined)).toBe('default');
    expect(customerForOrg(HUB_ORG_ID)).toBe('default');
    expect(customerForOrg(NORDSTROM_ORG_ID)).toBe('5b7227b4');

    await post(makeApp(), { ...APP_REPORT, devinOrgId: NORDSTROM_ORG_ID, devinUserId: 'user-nord' });
    await flush();
    expect(createSessionAndAlert.mock.calls[0][0]).toMatchObject({ customer: '5b7227b4', devinOrgId: NORDSTROM_ORG_ID, devinUserId: 'user-nord' });
  });

  test('creates the session as the reporter resolved from devinEmail in the default org', async () => {
    listOrgUsers.mockResolvedValueOnce([{ email: 'Shahmir.Masood@cognition.ai', user_id: 'user-shahmir' }]);
    await post(makeApp(), APP_REPORT);
    await flush();
    expect(listOrgUsers).toHaveBeenCalledWith(HUB_ORG_ID, expect.any(Object));
    expect(createSessionAndAlert.mock.calls[0][0].devinUserId).toBe('user-shahmir');
  });

  test('falls back to enterprise admins, then to the customer default user', async () => {
    listEnterpriseAdmins.mockResolvedValueOnce([{ email: 'shahmir.masood@cognition.ai', user_id: 'admin-shahmir' }]);
    await post(makeApp(), APP_REPORT);
    await flush();
    expect(createSessionAndAlert.mock.calls[0][0].devinUserId).toBe('admin-shahmir');

    jest.clearAllMocks();
    router._resetReportCap();
    await post(makeApp(), APP_REPORT);
    await flush();
    expect(createSessionAndAlert.mock.calls[0][0].devinUserId).toBeUndefined();
  });

  test('uses a forwarded devinUserId without looking up the email', async () => {
    await post(makeApp(), { ...APP_REPORT, devinUserId: 'user-direct' });
    await flush();
    expect(listOrgUsers).not.toHaveBeenCalled();
    expect(createSessionAndAlert.mock.calls[0][0].devinUserId).toBe('user-direct');
  });

  test('resolveUserIdByEmail returns empty on missing input or lookup failure', async () => {
    expect(await resolveUserIdByEmail('', HUB_ORG_ID)).toBe('');
    expect(await resolveUserIdByEmail('a@b.c', '')).toBe('');
    listOrgUsers.mockRejectedValueOnce(new Error('boom'));
    expect(await resolveUserIdByEmail('a@b.c', HUB_ORG_ID)).toBe('');
  });

  test('a session creation failure is logged and does not reject the report', async () => {
    createSessionAndAlert.mockRejectedValueOnce(new Error('devin down'));
    const { reference, sessionPromise } = reportAppFailure(APP_REPORT);
    await expect(sessionPromise).resolves.toBeUndefined();
    expect(reference).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('GIFT_FINDER_IOS_SESSION_PLATFORM defaults to macos when unset', () => {
    expect(GIFT_FINDER_IOS_SESSION_PLATFORM).toBe('macos');
  });
});
