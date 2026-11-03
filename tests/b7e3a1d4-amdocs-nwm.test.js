jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: {
    captureException: jest.fn(),
    withScope: jest.fn((callback) => {
      const scope = { setTransactionName: jest.fn(), addEventProcessor: jest.fn() };
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

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const express = require('express');
const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const {
  AMDOCS_NWM_SESSION_PLATFORM,
  APP_REMEDIATION_DIRECTIVE,
  APP_SERVICE,
  ERROR_CODE,
  IOS_ERROR_PATH,
  isAppReport,
} = require('../app/services/verticals/amdocs-nwm');
const router = require('../app/routes/verticals/amdocs-nwm');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
const customer = require('../config/customers/b7e3a1d4');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'app', 'public', 'verticals', 'b7e3a1d4.html'), 'utf8');

const WEB_REPORT = {
  source: 'amdocs-nwm/web',
  service: APP_SERVICE,
  platform: 'web',
  screen: 'TaskDetail',
  action: 'saveAndComplete',
  errorType: 'WorkflowError.closeoutPolicyNotFound(priority: "critical", project: "TMO")',
  errorMessage: 'No SLA close-out policy for priority critical (task TSK-716942-2, project TMO)',
  errorCode: 'NWM-WF-4221',
  ticketId: '716942',
  taskId: 'TSK-716942-2',
  taskTitle: 'Validation',
  priority: 'critical',
  project: 'TMO',
  workflow: 'FCC Drive Test Check in',
  assignee: 'Nikos Rittas',
  appVersion: '2.2.30',
  devinUserId: '',
  devinEmail: '',
  devinOrgId: '',
};

/** Evaluates the page's workflow rules (no DOM) so the planted defect is tested as code. */
function loadWorkflowRules() {
  const script = PAGE.match(/<script>([\s\S]*?)<\/script>/)[1];
  const rules = script.slice(script.indexOf('var PRIORITY_LABELS'), script.indexOf('var state ='));
  const tasks = script.slice(script.indexOf('var TASKS'), script.indexOf('/* Mirrors'));
  const sandbox = {};
  vm.runInNewContext(`${tasks}\n${rules}\nthis.completeTask = completeTask; this.TASKS = TASKS;`, sandbox);
  return sandbox;
}

async function postJson(server, body) {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}${IOS_ERROR_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

describe('Amdocs NWM web replica (/amdocs)', () => {
  test('is reachable at the friendly aliases', () => {
    expect(customer.aliases).toEqual(expect.arrayContaining(['amdocs', 'nwm', 'amdocs-nwm']));
  });

  test('reports with the NWM client identity and supports ?reports=off', () => {
    expect(PAGE).toContain("var REPORT_PATH = '/api/amdocs/nwm/error';");
    expect(PAGE).toContain("source: 'amdocs-nwm/web'");
    expect(PAGE).toContain("service: 'customer-amdocs-nwm'");
    expect(PAGE).toContain("get('reports') !== 'off'");
    expect(PAGE).not.toMatch(/@cognition\.ai|org_[A-Za-z0-9]{8,}/);
  });

  test('shows a red error banner and modal on the failed close-out', () => {
    expect(PAGE).toMatch(/--red: #d92d20/);
    expect(PAGE).toContain('id="task-error"');
    expect(PAGE).toContain('id="error-modal"');
    expect(PAGE).toContain('Save &amp; Complete failed');
  });

  test('keeps the planted defect: critical tasks have no SLA close-out policy', () => {
    const { completeTask, TASKS } = loadWorkflowRules();
    const [validation] = TASKS['716942'].filter((t) => t.priority === 'critical');
    const [routeUpload] = TASKS['716951'];

    expect(validation.title).toBe('Validation');
    expect(() => completeTask(validation, 'TMO')).toThrow(/No SLA close-out policy for priority critical/);
    expect(completeTask(routeUpload, 'TMO')).toMatchObject({ policyId: 'SLA-CO-H', stage: 'Completed' });
  });
});

describe('Amdocs NWM failure report bridge', () => {
  let server;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use(router);
    server = app.listen(0, done);
  });

  afterAll((done) => { server.close(done); });

  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('accepts web and ios sources only', () => {
    expect(isAppReport(WEB_REPORT)).toBe(true);
    expect(isAppReport({ ...WEB_REPORT, source: 'amdocs-nwm/ios' })).toBe(true);
    expect(isAppReport({ ...WEB_REPORT, source: 'amdocs-nwm/android' })).toBe(false);
    expect(isAppReport({ ...WEB_REPORT, service: 'customer-ios-demo' })).toBe(false);
  });

  test('rejects reports with the wrong identity', async () => {
    const { status } = await postJson(server, { ...WEB_REPORT, source: 'ios-demos/09026519/ios' });
    expect(status).toBe(400);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('raises one Slack alert that starts a Linux orchestrator fanning out to macOS (iOS) and Linux (web) children', async () => {
    const { status, body } = await postJson(server, WEB_REPORT);
    expect(status).toBe(202);
    expect(body).toMatchObject({ received: true, service: APP_SERVICE, sessionRequested: true });

    await new Promise((resolve) => { setImmediate(resolve); });
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alertData = createSessionAndAlert.mock.calls[0][0];
    expect(alertData).toMatchObject({
      service: APP_SERVICE,
      customer: 'b7e3a1d4',
      sessionPlatform: 'linux',
      promptAppendix: APP_REMEDIATION_DIRECTIVE,
      skipVulnerablePr: true,
      title: `[Amdocs NWM] ${ERROR_CODE} Save & Complete failed for critical task (web)`,
    });
    expect(alertData.verticalLabel).toContain('Amdocs NWM');
    expect(alertData.extra).toMatchObject({ ticketId: '716942', priority: 'critical', platform: 'web' });
    expect(isInstantPathEvent(alertData)).toBe(true);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  test('the orchestrator prompt routes each platform to the right VM and repo', () => {
    expect(AMDOCS_NWM_SESSION_PLATFORM).toBe('linux');
    expect(APP_REMEDIATION_DIRECTIVE).toMatch(/\*macOS\* child for `COG-GTM\/event-driven-ios`/);
    expect(APP_REMEDIATION_DIRECTIVE).toMatch(/\*Linux\* child for `COG-GTM\/event-driven-devin`/);
    expect(APP_REMEDIATION_DIRECTIVE).toContain('AmdocsNWMCore/');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('?reports=off');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('[DEMO — DO NOT MERGE]');
  });
});
