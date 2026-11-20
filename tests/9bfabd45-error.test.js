jest.mock('../app/services/datadog-incidents', () => ({
  declareDatadogIncident: jest.fn(() => Promise.resolve({ id: 'inc-uuid', publicId: 412 })),
}));

jest.mock('../app/services/datadog-incident-slack', () => ({
  queueIncidentChannelInvites: jest.fn(() => true),
}));

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
}));

jest.mock('../app/services/slack', () => {
  const actual = jest.requireActual('../app/services/slack');
  return {
    ...actual,
    postAlertToSlack: jest.fn(() => Promise.resolve('1712345678.000100')),
    createChannel: jest.fn((_token, name) => Promise.resolve({ id: 'C-SEV-1', name })),
    inviteToChannel: jest.fn(() => Promise.resolve(true)),
    findChannelByNameFragment: jest.fn(() => Promise.resolve(null)),
    joinChannel: jest.fn(() => Promise.resolve(true)),
    getChannelHistory: jest.fn(() => Promise.resolve([])),
    postPersonaMessage: jest.fn(() => Promise.resolve('1712345678.000200')),
  };
});

jest.mock('../app/services/devin-api', () => ({
  createDevinSession: jest.fn(() => Promise.resolve({ sessionId: 'plain-session', url: 'https://app.devin.ai/sessions/plain-session' })),
  sendDevinSessionMessage: jest.fn(() => Promise.resolve({
    sessionId: 'bot-998a62ccfc0a483d8204ff78372b96d3',
    url: 'https://app.devin.ai/sessions/bot-998a62ccfc0a483d8204ff78372b96d3',
  })),
  listOrgUsers: jest.fn(() => Promise.resolve([
    { user_id: 'nexen-member-1', email: 'Member@Nexen.example' },
  ])),
  listEnterpriseAdmins: jest.fn(() => Promise.resolve([
    { user_id: 'ent-admin-1', email: 'admin@enterprise.example' },
  ])),
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

const express = require('express');
const http = require('http');
const axios = require('axios');
const { createSessionAndAlert } = require('../app/services/devin-session');
const { declareDatadogIncident } = require('../app/services/datadog-incidents');
const { queueIncidentChannelInvites } = require('../app/services/datadog-incident-slack');
const {
  createDevinSession,
  sendDevinSessionMessage,
  listOrgUsers,
  listEnterpriseAdmins,
} = require('../app/services/devin-api');
const {
  postAlertToSlack,
  createChannel,
  inviteToChannel,
  findChannelByNameFragment,
  joinChannel,
  getChannelHistory,
  postPersonaMessage,
} = require('../app/services/slack');
const { runWithLegacyAlertsSuppressed } = require('../app/services/oncall-suppression');
const { Sentry } = require('../app/telemetry/sentry');
const { incrementMetric } = require('../app/telemetry/datadog');
const logger = require('../app/telemetry/logger');
const {
  reportAppFailure,
  resetSettlementIncidentForTests,
  APP_REMEDIATION_DIRECTIVE,
  SETTLEMENT,
  SETTLEMENT_REMEDIATION_DIRECTIVE,
  OWNER,
} = require('../app/services/verticals/9bfabd45');
const router = require('../app/routes/verticals/9bfabd45');
const { getCustomerConfig } = require('../config/customers');
const { applyCustomerIdentity, isInstantPathEvent } = require('../app/routes/sentry-webhook');

const ORG_ID = 'org_69IXJFLrljx8zSAw';

const APP_REPORT = {
  source: 'nexen-custody/web',
  service: 'customer-9bfabd45-web',
  release: 'nexen-custody@1.0.0',
  environment: 'prod',
  platform: 'web',
  errorType: 'TypeError',
  errorMessage: "Cannot read properties of undefined (reading 'label')",
  stackTrace: 'buildAllocationBars (src/domain/allocation.ts:31)',
  screen: 'collateral_overview',
  action: 'load_allocation_chart',
  accountNumber: '',
  clientName: '',
  market: '',
  devinUserId: 'user-abc',
  devinOrgId: ORG_ID,
  devinEmail: 'hub.user@example.com',
  report: {
    clientId: 'abc-global',
    view: 'chart',
    nested: { deep: true },
  },
};

function postJson(server, path, body) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

describe('BNY NEXEN failure report (9bfabd45)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
    Sentry.withScope.mockClear();
    listOrgUsers.mockClear();
    listEnterpriseAdmins.mockClear();
  });

  test('customer config targets COG-GTM via the API trigger', () => {
    const config = getCustomerConfig('9bfabd45');
    expect(config.label).toBe('BNY NEXEN');
    expect(config.githubOrg).toBe('COG-GTM');
    expect(config.triggerMode).toBe('api');
  });

  test('reportAppFailure raises the alert under the app identity and the demo owner', () => {
    const { reference } = reportAppFailure(APP_REPORT);

    expect(reference).toMatch(/^[0-9a-f-]{36}$/);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alertData = createSessionAndAlert.mock.calls[0][0];

    expect(alertData).not.toHaveProperty('slackPoster');
    expect(alertData).toMatchObject({
      customer: '9bfabd45',
      service: 'customer-9bfabd45-web',
      verticalLabel: 'BNY NEXEN',
      project: 'nexen-custody',
      release: 'nexen-custody@1.0.0',
      platform: 'web',
      errorType: 'TypeError',
      culprit: '9bfabd45/frontend/src/domain/allocation.ts \u2014 buildAllocationBars',
      devinUserId: 'user-abc',
      devinOrgId: ORG_ID,
      devinEmail: 'hub.user@example.com',
      slackMemberId: OWNER.slackMemberId,
      promptAppendix: APP_REMEDIATION_DIRECTIVE,
    });
    expect(alertData.tags).toEqual(expect.arrayContaining([
      { key: 'service', value: 'customer-9bfabd45-web' },
      { key: 'screen', value: 'collateral_overview' },
      { key: 'action', value: 'load_allocation_chart' },
      { key: 'scenario', value: 'collateral-overview-chart' },
    ]));
    expect(alertData.extra.report).toEqual({ clientId: 'abc-global', view: 'chart' });

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [captured, context] = Sentry.captureException.mock.calls[0];
    expect(captured.name).toBe('TypeError');
    expect(context.tags.alert_path).toBe('instant');
    // Browser frames give Sentry no module path, so the transaction is what ends
    // up in the issue culprit; it must carry the slug for tagless webhooks.
    const scope = Sentry.withScope.mock.results[0].value;
    expect(scope.setTransactionName).toHaveBeenCalledWith('POST /api/9bfabd45/error');
  });

  test('caps how many report entries reach Sentry and Slack', () => {
    const report = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, i]));
    reportAppFailure({ ...APP_REPORT, report });
    expect(Object.keys(createSessionAndAlert.mock.calls[0][0].extra.report)).toHaveLength(24);
  });

  test('falls back to the demo owner email when the client sends no identity', () => {
    const anonymous = { ...APP_REPORT };
    delete anonymous.devinUserId;
    delete anonymous.devinOrgId;
    delete anonymous.devinEmail;
    reportAppFailure(anonymous);
    const alertData = createSessionAndAlert.mock.calls[0][0];
    expect(alertData.devinEmail).toBe(OWNER.email);
    expect(alertData.slackMemberId).toBe(OWNER.slackMemberId);
  });

  test('resolves the reporter email to an org member when the client has no user id', async () => {
    const { sessionPromise } = reportAppFailure({
      ...APP_REPORT,
      devinUserId: '',
      devinEmail: 'member@nexen.example',
    });
    await sessionPromise;
    expect(listOrgUsers).toHaveBeenCalledWith(ORG_ID, expect.any(Object));
    expect(createSessionAndAlert.mock.calls[0][0].devinUserId).toBe('nexen-member-1');
  });

  test('falls back to enterprise admins for unknown emails', async () => {
    await reportAppFailure({ ...APP_REPORT, devinUserId: '', devinEmail: 'admin@enterprise.example' }).sessionPromise;
    expect(listEnterpriseAdmins).toHaveBeenCalled();
    expect(createSessionAndAlert.mock.calls[0][0].devinUserId).toBe('ent-admin-1');
  });

  test('the directive names the NEXEN repo, the chart fix and stops before merge', () => {
    expect(APP_REMEDIATION_DIRECTIVE).toContain('github.com/COG-GTM/bny');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('frontend/src/domain/allocation.ts');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('backend/src/main/resources/data.sql');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('app/public/verticals/9bfabd45-app/');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('STOP for human approval');
  });

  test('Sentry webhook maps the app service tag to the NEXEN identity', () => {
    const alertData = applyCustomerIdentity({
      issueTitle: "TypeError: Cannot read properties of undefined (reading 'label')",
      culprit: 'buildAllocationBars',
      tags: [['service', 'customer-9bfabd45-web'], ['platform', 'web']],
    });

    expect(alertData).toMatchObject({
      customer: '9bfabd45',
      verticalLabel: 'BNY NEXEN',
      service: 'customer-9bfabd45-web',
      project: 'nexen-custody',
      promptAppendix: APP_REMEDIATION_DIRECTIVE,
    });
  });

  test('Sentry webhook skips the events the instant path already alerted on, tagged or tagless', () => {
    expect(isInstantPathEvent({
      culprit: '9bfabd45/frontend/src/domain/allocation.ts \u2014 buildAllocationBars',
      tags: [['service', 'customer-9bfabd45-web'], ['alert_path', 'instant']],
    })).toBe(true);
    expect(isInstantPathEvent({
      culprit: 'POST /api/9bfabd45/error',
      tags: [],
    })).toBe(true);
  });

  describe('POST /api/9bfabd45/error', () => {
    let server;

    beforeAll((done) => {
      const app = express();
      app.use(express.json());
      app.use(router);
      server = app.listen(0, done);
    });

    afterAll((done) => {
      server.close(done);
    });

    test('accepts a report from the NEXEN client', async () => {
      const res = await postJson(server, '/api/9bfabd45/error', APP_REPORT);
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({
        received: true,
        service: 'customer-9bfabd45-web',
        sessionRequested: true,
      });
      expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    });

    test('rejects a body that does not carry the app identity', async () => {
      const res = await postJson(server, '/api/9bfabd45/error', { ...APP_REPORT, service: 'something-else' });
      expect(res.status).toBe(400);
      expect(res.body.received).toBe(false);
      expect(createSessionAndAlert).not.toHaveBeenCalled();
    });
  });
});

describe('BNY NEXEN settlement batch release (9bfabd45)', () => {
  const envKeys = [
    'NEXEN_SRE_BOT_ID',
    'NEXEN_SRE_BOT_SLACK_ID',
    'NEXEN_SRE_BOT_WEBHOOK_URL',
    'NEXEN_SRE_BOT_WEBHOOK_SECRET',
    'NEXEN_ALERT_USERNAME',
    'NEXEN_SEV1_CHANNEL_ID',
    'DD_VERSION',
    'NEXEN_PERSONAS',
    'PUBLIC_BASE_URL',
    'SLACK_BOT_TOKEN',
    'SLACK_ONCALL_BOT_TOKEN',
    'INCIDENT_LAB_SLACK_BOT_TOKEN',
  ];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const BOT_ID = 'bot-998a62ccfc0a483d8204ff78372b96d3';
  const BOT_SLACK_ID = 'U0CJZC8RZBM';
  const FIXED_SEV1_CHANNEL_ID = 'C0CJQDXKD9D';

  const SETTLEMENT_REPORT = {
    source: 'nexen-custody/web',
    service: 'customer-9bfabd45-web',
    platform: 'web',
    screen: 'transactions',
    action: 'release_settlement_batch',
    accountNumber: '8842910',
    errorType: 'TypeError',
    errorMessage: "Cannot read properties of undefined (reading 'currency')",
    stackTrace: 'at buildReleaseLines (settlement.ts:24:37)',
    timestamp: '2026-11-20T08:00:00.000Z',
    report: { batchId: 'SB-20260918-USD', instructionCount: 4, settlementCurrency: 'USD' },
  };
  const DECLARATION_TS = (Date.parse(SETTLEMENT_REPORT.timestamp) / 1000 + 5).toFixed(6);
  const SRE_BOT_DECLARATION = {
    type: 'message',
    ts: DECLARATION_TS,
    user: BOT_SLACK_ID,
    text: `SEV-1 declared: ${SETTLEMENT.incidentTitle}`,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    resetSettlementIncidentForTests();
    process.env.NEXEN_SRE_BOT_ID = 'off';
    delete process.env.NEXEN_SRE_BOT_SLACK_ID;
    process.env.NEXEN_SRE_BOT_WEBHOOK_URL = 'off';
    delete process.env.NEXEN_SRE_BOT_WEBHOOK_SECRET;
    delete process.env.NEXEN_ALERT_USERNAME;
    delete process.env.NEXEN_SEV1_CHANNEL_ID;
    process.env.DD_VERSION = 'current-run-sha';
    delete process.env.PUBLIC_BASE_URL;
    process.env.SLACK_BOT_TOKEN = 'test-slack-token';
    delete process.env.NEXEN_PERSONAS;
    delete process.env.SLACK_ONCALL_BOT_TOKEN;
    delete process.env.INCIDENT_LAB_SLACK_BOT_TOKEN;
    findChannelByNameFragment.mockReset();
    findChannelByNameFragment.mockResolvedValue(null);
    joinChannel.mockReset();
    joinChannel.mockResolvedValue(true);
    getChannelHistory.mockReset();
    getChannelHistory.mockResolvedValue([SRE_BOT_DECLARATION]);
    jest.spyOn(axios, 'post').mockResolvedValue({ status: 202 });
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('does not post a settlement alert in fixed-channel mode', async () => {
    process.env.NEXEN_SEV1_CHANNEL_ID = FIXED_SEV1_CHANNEL_ID;
    const { sessionPromise, incidentPromise } = reportAppFailure(SETTLEMENT_REPORT);
    await sessionPromise;
    await expect(incidentPromise).resolves.toMatchObject({ status: 'declared', publicId: 412 });

    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(postAlertToSlack).not.toHaveBeenCalled();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(incrementMetric).toHaveBeenCalledWith('settlement_batch.failure', expect.any(Object));
    expect(declareDatadogIncident).toHaveBeenCalledTimes(1);
  });

  test('falls back to SETTLEMENT.slackChannelId when the fixed channel is unset', async () => {
    process.env.NEXEN_SEV1_CHANNEL_ID = 'off';
    const { sessionPromise } = reportAppFailure(SETTLEMENT_REPORT);
    await sessionPromise;
    expect(createSessionAndAlert.mock.calls[0][0].slackChannelId).toBe('C0CJPN2C5D5');
  });

  test.each(['', 'off', ' OFF '])('omits the alert poster when NEXEN_ALERT_USERNAME is %j', async (username) => {
    process.env.NEXEN_ALERT_USERNAME = username;
    process.env.NEXEN_SEV1_CHANNEL_ID = 'off';
    const { sessionPromise } = reportAppFailure(SETTLEMENT_REPORT);
    await sessionPromise;
    expect(createSessionAndAlert.mock.calls[0][0]).not.toHaveProperty('slackPoster');
  });

  test('uses a configured NEXEN alert username', async () => {
    process.env.NEXEN_ALERT_USERNAME = 'Custom Name';
    process.env.NEXEN_SEV1_CHANNEL_ID = 'off';
    const { sessionPromise } = reportAppFailure(SETTLEMENT_REPORT);
    await sessionPromise;
    expect(createSessionAndAlert.mock.calls[0][0].slackPoster).toEqual({
      username: 'Custom Name',
      icon_emoji: ':satellite_antenna:',
    });
  });

  test('declares a SEV-1 and invites the demo owner to its channel', async () => {
    const { incidentPromise } = reportAppFailure(SETTLEMENT_REPORT);
    await expect(incidentPromise).resolves.toMatchObject({ status: 'declared', publicId: 412 });
    expect(declareDatadogIncident).toHaveBeenCalledWith(expect.objectContaining({
      title: SETTLEMENT.incidentTitle,
      severity: 'SEV-1',
      service: 'nexen-settlement',
      repoUrl: 'https://github.com/COG-GTM/bny',
    }));
    expect(declareDatadogIncident.mock.calls[0][0].summary).toContain('SB-20260918-USD');
    expect(queueIncidentChannelInvites).toHaveBeenCalledWith({ publicId: 412, userIds: [OWNER.slackMemberId] });
  });

  test('SRE Bot mode skips the alert, finds its declaration, and pages personas in that thread', async () => {
    process.env.NEXEN_SRE_BOT_ID = BOT_ID;
    process.env.SLACK_ONCALL_BOT_TOKEN = 'oncall-test-token';
    process.env.INCIDENT_LAB_SLACK_BOT_TOKEN = 'incident-test-token';
    jest.useFakeTimers();
    const { sessionPromise, incidentPromise } = reportAppFailure(SETTLEMENT_REPORT);
    await expect(sessionPromise).resolves.toEqual({
      channelId: FIXED_SEV1_CHANNEL_ID,
      threadTs: null,
    });
    const incident = await incidentPromise;
    expect(incident).toMatchObject({ status: 'declared', publicId: 412 });
    await jest.runAllTimersAsync();

    expect(postAlertToSlack).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(createDevinSession).not.toHaveBeenCalled();
    expect(createChannel).not.toHaveBeenCalled();
    expect(inviteToChannel).toHaveBeenCalledWith('incident-test-token', FIXED_SEV1_CHANNEL_ID, [
      OWNER.slackMemberId,
      BOT_SLACK_ID,
    ]);
    expect(queueIncidentChannelInvites).not.toHaveBeenCalled();
    expect(findChannelByNameFragment).not.toHaveBeenCalled();
    expect(getChannelHistory).toHaveBeenCalledWith(
      'incident-test-token',
      FIXED_SEV1_CHANNEL_ID,
      { oldest: (Date.parse(SETTLEMENT_REPORT.timestamp) / 1000).toFixed(6) },
    );
    expect(sendDevinSessionMessage).toHaveBeenCalledTimes(1);
    expect(sendDevinSessionMessage).toHaveBeenCalledWith(
      BOT_ID,
      expect.stringContaining(`channel id ${FIXED_SEV1_CHANNEL_ID}`),
      expect.any(Object),
    );
    const page = sendDevinSessionMessage.mock.calls[0][1];
    expect(page).toContain(`#pershing-sev1 (channel id ${FIXED_SEV1_CHANNEL_ID})`);
    expect(page).toContain('*Failure at:* 2026-11-20T08:00:00.000Z (Nov 20, 2026, 3:00:00 AM EST)');
    expect(page).toContain('*Version:* current-run-sha');
    expect(page).not.toContain('8f125ca');
    expect(page).toContain('publicId=412');
    expect(page).toContain('nexen-settlement-');
    expect(page).toContain('service=nexen-settlement');
    expect(page).toContain('Do the incident work yourself in this session');
    expect(page).toContain('Stay in the scenario');
    expect(page).toContain('No alert was posted in Slack');
    expect(page).toContain('the declaration is your first top-level message');
    expect(page).toContain('only other top-level posts are the two short copies');
    expect(page).toContain('top-level copy');
    expect(page).toContain('permalink');
    expect(page).toContain('replies in the declaration thread');
    expect(page).not.toContain('NEXEN Monitoring');
    expect(page).not.toContain('*NEXEN Monitoring channel:*');
    expect(page).not.toContain('*NEXEN Monitoring thread ts:*');
    expect(page).toContain('SEV-1 declared: NEXEN: USD settlement batch release failing');
    expect(page).toContain('Datadog incident #412');
    expect(page).toContain('https://us5.datadoghq.com/incidents/412');
    expect(page).toContain('search_datadog_logs');
    expect(page).toContain('service:customer-9bfabd45-web status:error');
    expect(page).toContain('from = failure_at minus 60 seconds');
    expect(page).toContain('to = now');
    expect(page).toContain('at or after failure_at');
    expect(page).toContain('retry once after about 15 seconds');
    expect(page).toContain('1 error (this alert, Datadog indexing pending)');
    expect(page).toContain('Evidence pulled from Datadog');
    expect(page).toContain('Source: Datadog (logs + incident #412)');
    expect(page).toContain(`<@${OWNER.slackMemberId}>`);
    expect(page).toContain(`<@${OWNER.slackMemberId}> you're on call for NEXEN web`);
    expect(page).toContain('only opening top-level declaration in #pershing-sev1');
    expect(page).toContain('RCA-TEMPLATE.md');
    expect(page).toContain('rca-template.html');
    expect(page).not.toMatch(/#sev-1-incident-/);
    expect(page).toContain(`#pershing-sev1 (channel id ${FIXED_SEV1_CHANNEL_ID})`);
    expect(page).toContain(SETTLEMENT_REMEDIATION_DIRECTIVE);
    expect(page).toContain('SB-20260918-USD');
    expect(page).toContain('Never merge or roll back without a human.');
    expect(page).not.toContain('C0CJPN2C5D5');
    expect(page).not.toContain('pershing-access-alerts');
    expect(postPersonaMessage).toHaveBeenCalledTimes(7);
    expect(postPersonaMessage.mock.calls.every((call) => call[3] !== 'NEXEN Incident Bot')).toBe(true);
    expect(postPersonaMessage.mock.calls[0][2]).toBe(
      `thanks <@${BOT_SLACK_ID}>, taking IC. USD batch SB-20260918-USD is stuck with 4 instructions queued and a 16:00 ET cutoff`,
    );
    expect(postPersonaMessage.mock.calls.every((call) => call[1] === FIXED_SEV1_CHANNEL_ID)).toBe(true);
    expect(postPersonaMessage.mock.calls.every((call) => call[5] === DECLARATION_TS)).toBe(true);
    postPersonaMessage.mock.calls.forEach((call) => {
      expect(call[4]).toMatch(/^https:\/\/devindemos\.com\/bny\/avatars\/(maya-okafor|daniel-reyes|priya-natarajan)\.png$/);
    });
  });

  test('fixed-channel invitation failure still pages SRE Bot and schedules personas', async () => {
    process.env.NEXEN_SRE_BOT_ID = BOT_ID;
    jest.useFakeTimers();
    inviteToChannel.mockRejectedValueOnce(new Error('Slack invite failed'));

    const { incidentPromise } = reportAppFailure(SETTLEMENT_REPORT);
    await incidentPromise;
    await jest.runAllTimersAsync();

    expect(inviteToChannel).toHaveBeenCalledWith('test-slack-token', FIXED_SEV1_CHANNEL_ID, [
      OWNER.slackMemberId,
      BOT_SLACK_ID,
    ]);
    expect(postAlertToSlack).not.toHaveBeenCalled();
    expect(sendDevinSessionMessage).toHaveBeenCalledTimes(1);
    expect(sendDevinSessionMessage.mock.calls[0][1]).toContain(`channel id ${FIXED_SEV1_CHANNEL_ID}`);
    expect(postPersonaMessage).toHaveBeenCalledTimes(7);
    expect(postPersonaMessage.mock.calls.every((call) => call[5] === DECLARATION_TS)).toBe(true);
    expect(postPersonaMessage.mock.calls.every((call) => call[3] !== 'NEXEN Incident Bot')).toBe(true);
    expect(createChannel).not.toHaveBeenCalled();
    expect(queueIncidentChannelInvites).not.toHaveBeenCalled();
  });

  test('pages SRE Bot through the webhook with fixed-channel context', async () => {
    process.env.NEXEN_SRE_BOT_ID = BOT_ID;
    delete process.env.NEXEN_SRE_BOT_WEBHOOK_URL;
    process.env.NEXEN_SRE_BOT_WEBHOOK_SECRET = 'unit-test-secret';
    process.env.NEXEN_PERSONAS = 'off';

    const { incidentPromise } = reportAppFailure(SETTLEMENT_REPORT);
    await incidentPromise;

    expect(axios.post).toHaveBeenCalledWith(
      'https://devin-gtm.devinenterprise.com/api/webhooks/automations/org_69IXJFLrljx8zSAw/auto-3e9cab1507444129b9cf3f56344d8ee9',
      expect.objectContaining({
        bot_id: BOT_ID,
        source: 'devindemos.com',
        incident: SETTLEMENT.incidentTitle,
        reference: expect.any(String),
        slack_channel_id: FIXED_SEV1_CHANNEL_ID,
        slack_thread_ts: null,
        alert_channel_id: FIXED_SEV1_CHANNEL_ID,
        sev1_channel_id: FIXED_SEV1_CHANNEL_ID,
        datadog_incident_id: 412,
        datadog_incident_url: 'https://us5.datadoghq.com/incidents/412',
        failure_at: '2026-11-20T08:00:00.000Z',
      }),
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Webhook-Secret': 'unit-test-secret' }),
      }),
    );
    expect(sendDevinSessionMessage).not.toHaveBeenCalled();
  });

  test('uses server receive time when the report has no timestamp', async () => {
    process.env.NEXEN_SRE_BOT_ID = BOT_ID;
    delete process.env.NEXEN_SRE_BOT_WEBHOOK_URL;
    process.env.NEXEN_SRE_BOT_WEBHOOK_SECRET = 'unit-test-secret';
    process.env.NEXEN_PERSONAS = 'off';
    jest.useFakeTimers().setSystemTime(new Date('2026-11-20T08:15:00.000Z'));
    const report = { ...SETTLEMENT_REPORT };
    delete report.timestamp;

    const { incidentPromise } = reportAppFailure(report);
    await incidentPromise;

    const webhookPayload = axios.post.mock.calls[0][1];
    expect(webhookPayload.failure_at).toBe('2026-11-20T08:15:00.000Z');
    expect(webhookPayload.message).toContain('*Failure at:* 2026-11-20T08:15:00.000Z (Nov 20, 2026, 3:15:00 AM EST)');
  });

  test('skips webhook paging and logs an error when the webhook secret is missing', async () => {
    process.env.NEXEN_SRE_BOT_ID = BOT_ID;
    delete process.env.NEXEN_SRE_BOT_WEBHOOK_URL;
    process.env.NEXEN_PERSONAS = 'off';
    const errorLog = jest.spyOn(logger, 'error').mockImplementation(() => {});

    const { incidentPromise } = reportAppFailure(SETTLEMENT_REPORT);
    await incidentPromise;

    expect(axios.post).not.toHaveBeenCalled();
    expect(sendDevinSessionMessage).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(
      'NEXEN SRE Bot webhook secret is missing; page skipped',
      expect.objectContaining({ reference: expect.any(String), botId: BOT_ID }),
    );
  });

  test('NEXEN_SRE_BOT_WEBHOOK_URL=off pages through the v3 messages API', async () => {
    process.env.NEXEN_SRE_BOT_ID = BOT_ID;
    process.env.NEXEN_SRE_BOT_WEBHOOK_URL = 'off';
    process.env.NEXEN_PERSONAS = 'off';

    const { incidentPromise } = reportAppFailure(SETTLEMENT_REPORT);
    await incidentPromise;

    expect(axios.post).not.toHaveBeenCalled();
    expect(sendDevinSessionMessage).toHaveBeenCalledWith(
      BOT_ID,
      expect.stringContaining(`channel id ${FIXED_SEV1_CHANNEL_ID}`),
      expect.any(Object),
    );
  });

  test('SRE Bot keeps posting the app alert when the fixed channel is disabled', async () => {
    process.env.NEXEN_SRE_BOT_ID = BOT_ID;
    process.env.NEXEN_SEV1_CHANNEL_ID = 'off';
    process.env.NEXEN_PERSONAS = 'off';
    const { sessionPromise, incidentPromise } = reportAppFailure(SETTLEMENT_REPORT);
    await sessionPromise;
    await incidentPromise;

    expect(postAlertToSlack).toHaveBeenCalledTimes(1);
    expect(postAlertToSlack.mock.calls[0][0].slackChannelId).toBe('C0CJPN2C5D5');
    expect(postAlertToSlack.mock.calls[0][1]).toBe('test-slack-token');
  });

  test('retries a taken settlement channel name with the -2 suffix', async () => {
    process.env.NEXEN_SRE_BOT_ID = BOT_ID;
    process.env.NEXEN_SEV1_CHANNEL_ID = 'off';
    process.env.NEXEN_PERSONAS = 'off';
    createChannel
      .mockRejectedValueOnce(Object.assign(new Error('name taken'), { code: 'name_taken' }))
      .mockResolvedValueOnce({ id: 'C-SEV-1-2', name: 'pershing-sev1-412-2' });

    const { incidentPromise } = reportAppFailure(SETTLEMENT_REPORT);
    await incidentPromise;

    expect(createChannel).toHaveBeenNthCalledWith(1, 'test-slack-token', 'pershing-sev1-412');
    expect(createChannel).toHaveBeenNthCalledWith(2, 'test-slack-token', 'pershing-sev1-412-2');
    expect(inviteToChannel).toHaveBeenCalledWith('test-slack-token', 'C-SEV-1-2', [
      OWNER.slackMemberId,
      BOT_SLACK_ID,
    ]);
  });

  test('falls back to Datadog channel invitations when creating the app channel fails', async () => {
    process.env.NEXEN_SRE_BOT_ID = BOT_ID;
    process.env.NEXEN_SEV1_CHANNEL_ID = 'off';
    process.env.NEXEN_SRE_BOT_SLACK_ID = 'off';
    process.env.NEXEN_PERSONAS = 'off';
    createChannel.mockRejectedValueOnce(new Error('missing channels:manage'));

    const { incidentPromise } = reportAppFailure(SETTLEMENT_REPORT);
    await incidentPromise;

    expect(queueIncidentChannelInvites).toHaveBeenCalledWith({
      publicId: 412,
      userIds: [OWNER.slackMemberId],
    });
    expect(findChannelByNameFragment).not.toHaveBeenCalled();
    expect(postPersonaMessage).not.toHaveBeenCalled();
    expect(sendDevinSessionMessage.mock.calls[0][1]).toContain('#sev-1-incident-412-…');
  });

  test('finds the Datadog channel, joins it, and runs personas after app-channel creation fails', async () => {
    process.env.NEXEN_SRE_BOT_ID = BOT_ID;
    process.env.NEXEN_SEV1_CHANNEL_ID = 'off';
    jest.useFakeTimers();
    createChannel.mockRejectedValueOnce(new Error('missing channels:manage'));
    findChannelByNameFragment
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'C_DD', name: 'sev-1-incident-412-x' });
    joinChannel.mockRejectedValueOnce(new Error('already_in_channel'));

    const { incidentPromise } = reportAppFailure(SETTLEMENT_REPORT);
    await incidentPromise;

    expect(findChannelByNameFragment).toHaveBeenCalledTimes(1);
    expect(findChannelByNameFragment).toHaveBeenCalledWith('test-slack-token', 'incident-412-');
    await jest.advanceTimersByTimeAsync(15000);
    expect(findChannelByNameFragment).toHaveBeenCalledTimes(2);
    expect(joinChannel).toHaveBeenCalledWith('test-slack-token', 'C_DD');
    await jest.advanceTimersByTimeAsync(330000);

    expect(postPersonaMessage).toHaveBeenCalledTimes(7);
    expect(postPersonaMessage.mock.calls.every((call) => call[1] === 'C_DD')).toBe(true);
  });

  test('stops looking for the Datadog channel after five minutes', async () => {
    process.env.NEXEN_SRE_BOT_ID = BOT_ID;
    process.env.NEXEN_SEV1_CHANNEL_ID = 'off';
    jest.useFakeTimers();
    createChannel.mockRejectedValueOnce(new Error('missing channels:manage'));

    const { incidentPromise } = reportAppFailure(SETTLEMENT_REPORT);
    await incidentPromise;
    await jest.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(findChannelByNameFragment).toHaveBeenCalledTimes(21);
    expect(joinChannel).not.toHaveBeenCalled();
    expect(postPersonaMessage).not.toHaveBeenCalled();
  });

  test('posts seven persona messages in order and replaces SRE Bot mentions', async () => {
    process.env.NEXEN_SRE_BOT_ID = BOT_ID;
    jest.useFakeTimers();
    const { incidentPromise } = reportAppFailure(SETTLEMENT_REPORT);
    await incidentPromise;
    await jest.runAllTimersAsync();

    expect(postPersonaMessage).toHaveBeenCalledTimes(7);
    expect(postPersonaMessage.mock.calls.map((call) => call[3])).toEqual([
      'Maya Okafor',
      'Priya Natarajan',
      'Daniel Reyes',
      'Priya Natarajan',
      'Maya Okafor',
      'Daniel Reyes',
      'Maya Okafor',
    ]);
    expect(postPersonaMessage.mock.calls.every((call) => call[5] === DECLARATION_TS)).toBe(true);
    const mentions = postPersonaMessage.mock.calls
      .map((call) => call[2])
      .filter((text) => text.includes(`<@${BOT_SLACK_ID}>`));
    expect(mentions).toHaveLength(2);
    expect(mentions.every((text) => !text.includes('{sre_bot}'))).toBe(true);
  });

  test('uses PUBLIC_BASE_URL for persona avatar URLs', async () => {
    process.env.NEXEN_SRE_BOT_ID = BOT_ID;
    process.env.PUBLIC_BASE_URL = 'https://demo.example.test/';
    jest.useFakeTimers();

    const { incidentPromise } = reportAppFailure(SETTLEMENT_REPORT);
    await incidentPromise;
    await jest.advanceTimersByTimeAsync(90000);

    expect(postPersonaMessage.mock.calls[0][4]).toMatch(/^https:\/\/demo\.example\.test\/bny\/avatars\/[a-z-]+\.png$/);
  });

  test('polls for the declaration and posts each persona reply at its configured offset', async () => {
    process.env.NEXEN_SRE_BOT_ID = BOT_ID;
    process.env.INCIDENT_LAB_SLACK_BOT_TOKEN = 'persona-test-token';
    process.env.SLACK_ONCALL_BOT_TOKEN = 'oncall-test-token';
    jest.useFakeTimers().setSystemTime(new Date(SETTLEMENT_REPORT.timestamp));
    getChannelHistory
      .mockRejectedValueOnce(Object.assign(new Error('Slack API error: missing_scope'), { code: 'missing_scope' }))
      .mockResolvedValueOnce([SRE_BOT_DECLARATION]);

    const { incidentPromise } = reportAppFailure(SETTLEMENT_REPORT);
    await incidentPromise;
    await jest.advanceTimersByTimeAsync(4999);
    expect(getChannelHistory).not.toHaveBeenCalled();
    expect(postPersonaMessage).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(getChannelHistory).toHaveBeenNthCalledWith(
      1,
      'persona-test-token',
      FIXED_SEV1_CHANNEL_ID,
      { oldest: (Date.parse(SETTLEMENT_REPORT.timestamp) / 1000).toFixed(6) },
    );
    expect(getChannelHistory).toHaveBeenNthCalledWith(
      2,
      'oncall-test-token',
      FIXED_SEV1_CHANNEL_ID,
      { oldest: (Date.parse(SETTLEMENT_REPORT.timestamp) / 1000).toFixed(6) },
    );
    expect(postPersonaMessage).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(29999);
    expect(postPersonaMessage).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(postPersonaMessage).toHaveBeenCalledTimes(1);
    expect(postPersonaMessage.mock.calls[0][2]).toBe(
      `thanks <@${BOT_SLACK_ID}>, taking IC. USD batch SB-20260918-USD is stuck with 4 instructions queued and a 16:00 ET cutoff`,
    );
    const offsets = [30000, 34000, 38000, 42000, 45000, 210000, 270000];
    let previousOffset = offsets[0];
    for (let index = 1; index < offsets.length; index += 1) {
      await jest.advanceTimersByTimeAsync(offsets[index] - previousOffset);
      previousOffset = offsets[index];
      expect(postPersonaMessage).toHaveBeenCalledTimes(index + 1);
    }
    expect(postPersonaMessage.mock.calls.every((call) => call[5] === DECLARATION_TS)).toBe(true);
  });

  test('does not post personas if the declaration is not found within six minutes', async () => {
    process.env.NEXEN_SRE_BOT_ID = BOT_ID;
    jest.useFakeTimers().setSystemTime(new Date(SETTLEMENT_REPORT.timestamp));
    getChannelHistory.mockResolvedValue([]);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});

    const { incidentPromise } = reportAppFailure(SETTLEMENT_REPORT);
    await incidentPromise;
    await jest.advanceTimersByTimeAsync(6 * 60 * 1000);

    expect(getChannelHistory).toHaveBeenCalledTimes(72);
    expect(postPersonaMessage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'NEXEN settlement SRE Bot declaration was not found before persona timeout',
      expect.objectContaining({ channelId: FIXED_SEV1_CHANNEL_ID }),
    );
  });

  test('posts each persona line as a declaration-thread reply', async () => {
    process.env.NEXEN_SRE_BOT_ID = BOT_ID;
    jest.useFakeTimers();
    const { incidentPromise } = reportAppFailure(SETTLEMENT_REPORT);
    await incidentPromise;
    await jest.runAllTimersAsync();

    expect(postPersonaMessage).toHaveBeenCalledTimes(7);
    expect(postPersonaMessage.mock.calls.every((call) => call[5] === DECLARATION_TS)).toBe(true);
  });

  test.each(['', 'off'])('when the SRE Bot Slack ID is %p, invites only the owner and uses plain persona text', async (slackId) => {
    process.env.NEXEN_SRE_BOT_ID = BOT_ID;
    process.env.NEXEN_SRE_BOT_SLACK_ID = slackId;
    jest.useFakeTimers();
    const { incidentPromise } = reportAppFailure(SETTLEMENT_REPORT);
    await incidentPromise;
    await jest.runAllTimersAsync();

    expect(inviteToChannel).toHaveBeenCalledWith('test-slack-token', FIXED_SEV1_CHANNEL_ID, [OWNER.slackMemberId]);
    const personaTexts = postPersonaMessage.mock.calls.map((call) => call[2]);
    const placeholderLines = personaTexts.filter((text) => text.includes('saw your root cause'));
    expect(placeholderLines).toHaveLength(1);
    expect(placeholderLines.every((text) => (
      text.includes('SRE Bot') && !text.includes('<@') && !text.includes('{sre_bot}')
    ))).toBe(true);
  });

  test('NEXEN_PERSONAS=off disables the scripted channel messages', async () => {
    process.env.NEXEN_SRE_BOT_ID = BOT_ID;
    process.env.NEXEN_PERSONAS = 'off';

    const { incidentPromise } = reportAppFailure(SETTLEMENT_REPORT);
    await incidentPromise;
    expect(postPersonaMessage).not.toHaveBeenCalled();
  });

  test('repeat releases inside the window reuse the open incident', async () => {
    const first = reportAppFailure(SETTLEMENT_REPORT);
    await first.incidentPromise;
    const second = reportAppFailure(SETTLEMENT_REPORT);
    expect(second.deduplicated).toBe(true);
    expect(second.reference).toBe(first.reference);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(declareDatadogIncident).toHaveBeenCalledTimes(1);
  });

  test('bot-mode repeat reports do not post another alert, page, or opening message', async () => {
    process.env.NEXEN_SRE_BOT_ID = BOT_ID;
    process.env.NEXEN_PERSONAS = 'off';
    const first = reportAppFailure(SETTLEMENT_REPORT);
    await first.incidentPromise;
    const second = reportAppFailure(SETTLEMENT_REPORT);

    expect(second.deduplicated).toBe(true);
    expect(postAlertToSlack).not.toHaveBeenCalled();
    expect(sendDevinSessionMessage).toHaveBeenCalledTimes(1);
    expect(createChannel).not.toHaveBeenCalled();
    expect(postPersonaMessage).not.toHaveBeenCalled();
  });

  test('legacy alert suppression also suppresses direct alerts and SRE Bot pages', async () => {
    process.env.NEXEN_SRE_BOT_ID = BOT_ID;
    const report = runWithLegacyAlertsSuppressed(() => reportAppFailure(SETTLEMENT_REPORT));
    await report.incidentPromise;

    expect(postAlertToSlack).not.toHaveBeenCalled();
    expect(sendDevinSessionMessage).not.toHaveBeenCalled();
    expect(declareDatadogIncident).toHaveBeenCalledTimes(1);
  });

  test('reports the SEV-1 as unavailable when Datadog keys are missing', async () => {
    declareDatadogIncident.mockResolvedValueOnce(null);
    const { incidentPromise } = reportAppFailure(SETTLEMENT_REPORT);
    await expect(incidentPromise).resolves.toMatchObject({ status: 'unavailable' });
    expect(queueIncidentChannelInvites).not.toHaveBeenCalled();
  });

  test('SRE Bot gets only the alert instructions when Datadog cannot declare the incident', async () => {
    process.env.NEXEN_SRE_BOT_ID = BOT_ID;
    process.env.NEXEN_PERSONAS = 'off';
    declareDatadogIncident.mockResolvedValueOnce(null);
    const { incidentPromise } = reportAppFailure(SETTLEMENT_REPORT);

    await expect(incidentPromise).resolves.toMatchObject({ status: 'unavailable' });
    const page = sendDevinSessionMessage.mock.calls[0][1];
    expect(page).not.toContain('1712345678.000100');
    expect(page).toContain(SETTLEMENT_REMEDIATION_DIRECTIVE);
    expect(page).not.toContain('publicId=');
    expect(page).not.toContain('*SEV-1 channel:*');
    expect(createChannel).not.toHaveBeenCalled();
    expect(queueIncidentChannelInvites).not.toHaveBeenCalled();
  });

  test('does not create a plain session when paging SRE Bot returns null', async () => {
    process.env.NEXEN_SRE_BOT_ID = BOT_ID;
    process.env.NEXEN_PERSONAS = 'off';
    sendDevinSessionMessage.mockResolvedValueOnce(null);

    const { incidentPromise } = reportAppFailure(SETTLEMENT_REPORT);
    await incidentPromise;

    expect(postAlertToSlack).not.toHaveBeenCalled();
    expect(sendDevinSessionMessage).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(createDevinSession).not.toHaveBeenCalled();
  });

  test('NEXEN_SRE_BOT_ID=off keeps the existing session and Datadog-channel flow', async () => {
    process.env.NEXEN_SRE_BOT_ID = 'off';
    process.env.NEXEN_SEV1_CHANNEL_ID = 'off';
    const { sessionPromise, incidentPromise } = reportAppFailure(SETTLEMENT_REPORT);
    await sessionPromise;
    await incidentPromise;

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert.mock.calls[0][0].slackChannelId).toBe('C0CJPN2C5D5');
    expect(postAlertToSlack).not.toHaveBeenCalled();
    expect(createChannel).not.toHaveBeenCalled();
    expect(sendDevinSessionMessage).not.toHaveBeenCalled();
    expect(queueIncidentChannelInvites).toHaveBeenCalledWith({
      publicId: 412,
      userIds: [OWNER.slackMemberId],
    });
  });

  test('chart failures keep the shared channel and declare no incident', async () => {
    const { sessionPromise, incidentPromise } = reportAppFailure(APP_REPORT);
    await sessionPromise;
    expect(incidentPromise).toBeUndefined();
    expect(createSessionAndAlert.mock.calls[0][0].slackChannelId).toBeUndefined();
    expect(declareDatadogIncident).not.toHaveBeenCalled();
  });
});
