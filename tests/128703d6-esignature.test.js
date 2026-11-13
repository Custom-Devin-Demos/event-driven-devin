jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));
jest.mock('../app/telemetry/logger', () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }));
jest.mock('../app/services/devin-session', () => ({ createSessionAndAlert: jest.fn() }));

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const Sentry = require('@sentry/node');
const { createSessionAndAlert } = require('../app/services/devin-session');
const svc = require('../app/services/verticals/128703d6');
const router = require('../app/routes/verticals/128703d6');
const { getCustomerConfig, listAliases } = require('../config/customers');

const VALUES = { 'initial-1': true, 'sign-1': true, 'title-1': 'VP, Procurement' };
const STYLE_SIG = { fullName: 'Alex Rivera', initials: 'AR', mode: 'style', style: 'caveat' };
let n = 0;
const nextId = () => `jest-demo-${++n}-abcdef`;
beforeEach(() => { svc._envelopes.clear(); svc._alertedEnvelopes.clear(); jest.clearAllMocks(); createSessionAndAlert.mockResolvedValue({ triggered: true }); });

describe('Docusign eSignature registration and assets', () => {
  test('registers slug and aliases', () => {
    expect(getCustomerConfig(svc.CUSTOMER)).toMatchObject({ label: 'Docusign — eSignature signing experience', triggerMode: 'api', githubOrg: 'COG-GTM' });
    expect(listAliases().docusign).toBe('128703d6');
    expect(listAliases()['docusign-signing']).toBe('128703d6');
  });

  test('page references only locally served assets that exist', () => {
    const dir = path.join(__dirname, '../app/public/verticals');
    const html = fs.readFileSync(path.join(dir, '128703d6.html'), 'utf8');
    const refs = [...html.matchAll(/\/verticals\/(128703d6-assets\/[\w.-]+)/g)].map(m => m[1]);
    expect(refs).toEqual(expect.arrayContaining(['128703d6-assets/esign.css', '128703d6-assets/esign.js', '128703d6-assets/logo.svg']));
    for (const ref of refs) expect(fs.existsSync(path.join(dir, ref))).toBe(true);
    const css = fs.readFileSync(path.join(dir, '128703d6-assets/esign.css'), 'utf8');
    for (const m of css.matchAll(/url\(([\w.-]+)\)/g)) expect(fs.existsSync(path.join(dir, '128703d6-assets', m[1]))).toBe(true);
    expect(html).toMatch(/Not affiliated with or endorsed by Docusign/);
    expect(html).not.toMatch(/https?:\/\/(fonts\.googleapis|www\.docusign)/);
  });
});

describe('envelope lifecycle', () => {
  test('starts sent with required tabs, completes with certificate, resets', () => {
    const id = nextId();
    const env = svc.getEnvelope(id);
    expect(env.status).toBe('sent');
    expect(env.signer.name).toBe('Alex Rivera');
    expect(env.envelopeId).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
    expect(svc.markViewed(id).history.map(h => h.action)).toContain('Viewed');
    const done = svc.completeEnvelope(id, { values: VALUES, signature: STYLE_SIG });
    expect(done.status).toBe('completed');
    expect(done.values['title-1']).toBe('VP, Procurement');
    expect(done.values['fullname-1']).toBe('Alex Rivera');
    expect(done.certificate).toMatchObject({ envelopeId: env.envelopeId, signatureAdoption: 'Pre-selected Style' });
    expect(done.certificate.documentHash).toMatch(/^[0-9a-f]{40}$/i);
    expect(done.history.slice(-1)[0].action).toBe('Completed');
    expect(svc.resetEnvelope(id).status).toBe('sent');
  });

  test('every valid style and drawn signatures complete; the flow never alerts', () => {
    for (const style of svc.SIGNATURE_STYLES) {
      expect(svc.completeEnvelope(nextId(), { values: VALUES, signature: { ...STYLE_SIG, style } }).status).toBe('completed');
    }
    const drawn = { ...STYLE_SIG, mode: 'draw', image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', initialsImage: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' };
    const drawnEnv = svc.completeEnvelope(nextId(), { values: VALUES, signature: drawn });
    expect(drawnEnv.certificate.signatureAdoption).toBe('Drawn on Device');
    expect(drawnEnv.signature.initialsImage).toBe(drawn.initialsImage);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('accepts initials from uncased scripts at validation (completion hits the planted stamp defect)', () => {
    const id = nextId();
    svc.getEnvelope(id, { signerName: '张伟' });
    expect(() => svc.completeEnvelope(id, { values: VALUES, signature: { ...STYLE_SIG, fullName: '张伟', initials: '张' } }))
      .toThrow(expect.objectContaining({ status: 500, code: 'ENVELOPE_COMPLETION_FAILED' }));
  });

  test('custom signer name and per-demo isolation', () => {
    const a = nextId(); const b = nextId();
    expect(svc.getEnvelope(a, { signerName: 'Jordan Lee' }).signer.name).toBe('Jordan Lee');
    svc.completeEnvelope(b, { values: VALUES, signature: STYLE_SIG });
    expect(svc.getEnvelope(a).status).toBe('sent');
  });

  test.each([
    ['missing title', { ...VALUES, 'title-1': '  ' }, STYLE_SIG],
    ['missing initial', { ...VALUES, 'initial-1': false }, STYLE_SIG],
    ['bad style', VALUES, { ...STYLE_SIG, style: 'comic-sans' }],
    ['empty name', VALUES, { ...STYLE_SIG, fullName: '' }],
    ['draw without image', VALUES, { ...STYLE_SIG, mode: 'draw' }],
    ['bad initials image', VALUES, { ...STYLE_SIG, mode: 'draw', image: 'data:image/png;base64,AAAA', initialsImage: 'javascript:alert(1)' }],
  ])('rejects %s with a 400', (_label, values, signature) => {
    expect(() => svc.completeEnvelope(nextId(), { values, signature })).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe('planted defect: non-ASCII signer names (on-call brownfield)', () => {
  const JOSE = { ...STYLE_SIG, fullName: 'José Núñez', initials: 'JN' };
  const identity = { devinUserId: 'user-1', devinOrgId: 'org-1', devinEmail: 'presenter@cognition.ai' };

  test('ASCII signer sizes the certificate stamp and completes', () => {
    const done = svc.completeEnvelope(nextId(), { values: VALUES, signature: STYLE_SIG });
    expect(done.signature.stamp).toMatchObject({ text: 'Signed by: Alex Rivera', font: 'Helvetica', size: 7.5 });
  });

  test('José Núñez fails with a TypeError in fitSignerStamp, alerts once per envelope, reset re-arms', () => {
    const id = nextId();
    svc.getEnvelope(id, { signerName: 'José Núñez' });
    let thrown;
    try { svc.completeEnvelope(id, { values: VALUES, signature: JOSE, ...identity }); } catch (e) { thrown = e; }
    expect(thrown).toMatchObject({ name: 'TypeError', status: 500, code: 'ENVELOPE_COMPLETION_FAILED' });
    expect(thrown.message).toMatch(/reading 'wx'/);
    expect(svc.getEnvelope(id).status).toBe('sent');
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert).toMatchObject({ customer: '128703d6', errorType: 'TypeError', culprit: svc.CULPRIT, skipVulnerablePr: true, ...identity });
    expect(alert.promptAppendix).toContain('José Núñez');
    expect(alert.extra).toMatchObject({ step: 'fitSignerStamp', nonAsciiCharacters: 'éúñ' });

    expect(() => svc.completeEnvelope(id, { values: VALUES, signature: JOSE })).toThrow(TypeError);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);

    svc.resetEnvelope(id, { signerName: 'José Núñez' });
    expect(() => svc.completeEnvelope(id, { values: VALUES, signature: JOSE })).toThrow(TypeError);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(2);
  });

  test('suppressAlerts keeps the failure but skips Sentry and Devin', () => {
    expect(() => svc.completeEnvelope(nextId(), { values: VALUES, signature: JOSE, suppressAlerts: true })).toThrow(TypeError);
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});

describe('HTTP routes', () => {
  let server; let base;
  beforeAll(done => {
    const app = express(); app.use(express.json({ limit: '1mb' })); app.use(router);
    server = http.createServer(app).listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
  });
  afterAll(done => { server.closeAllConnections(); server.close(done); });
  const call = (p, { method = 'GET', body, demo = 'route-demo-123456' } = {}) => fetch(`${base}/api/128703d6${p}`, {
    method, headers: { 'content-type': 'application/json', 'x-demo-id': demo }, body: body && JSON.stringify(body),
  }).then(async r => ({ status: r.status, body: await r.json() }));

  test('get → view → complete → reset', async () => {
    expect((await call('/envelope')).body.envelope.status).toBe('sent');
    expect((await call('/envelope/view', { method: 'POST', body: {} })).status).toBe(200);
    const done = await call('/envelope/complete', { method: 'POST', body: { values: VALUES, signature: STYLE_SIG } });
    expect(done.status).toBe(200); expect(done.body.envelope.status).toBe('completed');
    expect((await call('/envelope/reset', { method: 'POST', body: {} })).body.envelope.status).toBe('sent');
  });

  test('non-ASCII completion returns a customer-facing 500 and passes the presenter identity', async () => {
    const demo = 'route-demo-jose-1234';
    const res = await call('/envelope/complete', { method: 'POST', demo, body: { values: VALUES, signature: { ...STYLE_SIG, fullName: 'José Núñez', initials: 'JN' }, devinUserId: 'user-9', devinEmail: 'presenter@cognition.ai' } });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ success: false, errorClass: 'TypeError', code: 'ENVELOPE_COMPLETION_FAILED' });
    expect(res.body.error).toMatch(/could not finish signing/);
    expect(res.body.reference).toMatch(/^[0-9A-F-]{36}$/);
    expect(createSessionAndAlert.mock.calls[0][0]).toMatchObject({ devinUserId: 'user-9', devinEmail: 'presenter@cognition.ai' });
  });

  test('without a saved browser identity the session starts as the default presenter and alerts #oncall-alerts', async () => {
    const res = await call('/envelope/complete', { method: 'POST', demo: 'route-demo-anon-1234', body: { values: VALUES, signature: { ...STYLE_SIG, fullName: 'José Núñez', initials: 'JN' } } });
    expect(res.status).toBe(500);
    expect(createSessionAndAlert.mock.calls[0][0]).toMatchObject({
      devinUserId: 'email|69efcc3741b62dd9be352f7c',
      devinEmail: 'shahmir.masood@cognition.ai',
      customer: '128703d6',
    });
    expect(require('../config/customers').getCustomerConfig('128703d6').slackChannelId).toBe('C0BNWUGCWBS');
  });

  test('reports: off keeps the failure but does not alert', async () => {
    const res = await call('/envelope/complete', { method: 'POST', demo: 'route-demo-quiet-1234', body: { values: VALUES, signature: { ...STYLE_SIG, fullName: 'José Núñez', initials: 'JN' }, reports: 'off' } });
    expect(res.status).toBe(500);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('validation errors return 400 JSON', async () => {
    const res = await call('/envelope/complete', { method: 'POST', body: { values: {}, signature: STYLE_SIG } });
    expect(res.status).toBe(400); expect(res.body.success).toBe(false); expect(res.body.error).toBeTruthy();
  });
});

describe('Sentry webhook dedup', () => {
  test('issue webhooks for the completion culprit are treated as already alerted', () => {
    const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
    expect(isInstantPathEvent({ culprit: svc.CULPRIT, tags: [] })).toBe(true);
  });
});
