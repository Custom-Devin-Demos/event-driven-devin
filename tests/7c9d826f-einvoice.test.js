jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));
jest.mock('../app/services/devin-session', () => ({
  ...jest.requireActual('../app/services/devin-session'),
  createSessionAndAlert: jest.fn(() => Promise.resolve({ sessionId: 'devin-test' })),
}));
jest.mock('../app/telemetry/logger', () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }));

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const Sentry = require('@sentry/node');
const { createSessionAndAlert, buildPrompt } = require('../app/services/devin-session');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
const { buildAlertBlocks } = require('../app/services/slack');
const svc = require('../app/services/verticals/7c9d826f');
const router = require('../app/routes/verticals/7c9d826f');
const { getCustomerConfig, listAliases } = require('../config/customers');

const VAT_GROUP_DOC = 'FV-2026-11-0414';
const STANDARD_DOC = 'FV-2026-11-0415';
beforeEach(() => { jest.clearAllMocks(); svc.resetAlertCooldown(); });

describe('Sovos e-invoice demo registration', () => {
  test('registers the slug and alias without operator impersonation', () => {
    expect(getCustomerConfig(svc.CUSTOMER)).toMatchObject({ triggerMode: 'api', githubOrg: 'COG-GTM' });
    expect(listAliases()['sovos-einvoice']).toBe('7c9d826f');
    const config = require('../config/customers/7c9d826f');
    expect(config.devinUserId).toBeUndefined(); expect(config.devinOrgId).toBeUndefined();
    const js = fs.readFileSync(path.join(__dirname, '../app/public/verticals/7c9d826f-assets/app.js'), 'utf8');
    for (const key of ['devinUserId', 'devinOrgId', 'devinEmail']) expect(js).toContain(`identity('${key}')`);
    expect(js).toContain('/api/7c9d826f/documents/');
    expect(js).not.toMatch(/clerk-user_|org-[a-f0-9]{32}/);
  });
});

describe('FA(3) mapping and tax-authority check', () => {
  test('totals are computed server-side', () => {
    const doc = svc.DOCUMENTS.find(d => d.id === VAT_GROUP_DOC);
    expect(svc.totals(doc)).toEqual({ net: 106000, vat: 24380, gross: 130380 });
  });

  test('a standard buyer carries both markers and is authorized', async () => {
    const doc = svc.DOCUMENTS.find(d => d.id === STANDARD_DOC);
    expect(svc.mapToFa3(doc).Podmiot2).toMatchObject({ JST: 2, GV: 2 });
    await expect(svc.submitDocument({ documentId: STANDARD_DOC })).resolves.toMatchObject({ success: true, document: { status: 'authorized', ksefNumber: expect.stringMatching(/^5260001246-20261126-[0-9A-F]{6}-7C$/) } });
    expect(createSessionAndAlert).not.toHaveBeenCalled(); expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('the authority check requires both buyer markers', () => {
    const xml = svc.mapToFa3(svc.DOCUMENTS.find(d => d.id === STANDARD_DOC));
    expect(svc.validateFa3(xml)).toEqual([]);
    delete xml.Podmiot2.GV;
    expect(svc.validateFa3(xml)).toEqual([expect.objectContaining({ path: 'Podmiot2/GV' })]);
  });

  test.each([undefined, null, 42, 'FV-0000', '__proto__'])('unknown document %j is a 404 without alerting', async documentId => {
    await expect(svc.submitDocument({ documentId })).rejects.toMatchObject({ name: 'ValidationError', status: 404, code: 'DOCUMENT_NOT_FOUND' });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('already authorized documents are not resent', async () => {
    await expect(svc.submitDocument({ documentId: 'FV-2026-11-0412' })).rejects.toMatchObject({ status: 409, code: 'ALREADY_AUTHORIZED' });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});

describe('planted buyer-marker defect and incident flow', () => {
  test('a VAT group buyer is rejected with one Sentry capture and one instant alert', async () => {
    await expect(svc.submitDocument({ documentId: VAT_GROUP_DOC, devinUserId: 'user-test', devinOrgId: 'org-test', devinEmail: 'demo@example.com' })).rejects.toMatchObject({
      name: 'TaxAuthorityRejection', status: 422, code: 'TAX_AUTHORITY_REJECTED',
      rejection: { authority: 'KSeF', schema: 'FA(3)', errors: [expect.objectContaining({ path: 'Podmiot2/JST' })] },
    });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ tags: expect.objectContaining({ customer: svc.CUSTOMER, alert_path: 'instant' }) }));
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert).toMatchObject({ skipVulnerablePr: true, customer: svc.CUSTOMER, service: svc.SERVICE, culprit: svc.CULPRIT, devinUserId: 'user-test', devinOrgId: 'org-test', devinEmail: 'demo@example.com', extra: { documentId: VAT_GROUP_DOC, vatGroupMember: true } });
    expect(isInstantPathEvent(alert)).toBe(true);
    expect(isInstantPathEvent({ culprit: svc.CULPRIT, tags: [] })).toBe(true);
    expect(buildPrompt(alert)).toContain('7c9d826f');
    expect(alert.promptAppendix).toContain('pull request against main; do not merge or deploy');
    const blocks = JSON.stringify(buildAlertBlocks(alert));
    expect(blocks).toContain('Sovos'); expect(blocks).toContain('Podmiot2/JST');
  });

  test('a retry inside the cooldown is still rejected but does not start a second session', async () => {
    await expect(svc.submitDocument({ documentId: VAT_GROUP_DOC })).rejects.toMatchObject({ code: 'TAX_AUTHORITY_REJECTED' });
    await expect(svc.submitDocument({ documentId: VAT_GROUP_DOC })).rejects.toMatchObject({ code: 'TAX_AUTHORITY_REJECTED' });
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    await expect(svc.submitDocument({ documentId: VAT_GROUP_DOC, devinUserId: 'another-presenter' })).rejects.toMatchObject({ code: 'TAX_AUTHORITY_REJECTED' });
    expect(createSessionAndAlert).toHaveBeenCalledTimes(2);
  });

  test('an undelivered alert does not hold the cooldown', async () => {
    createSessionAndAlert.mockResolvedValueOnce(null);
    await expect(svc.submitDocument({ documentId: VAT_GROUP_DOC })).rejects.toMatchObject({ code: 'TAX_AUTHORITY_REJECTED' });
    await new Promise(resolve => setImmediate(resolve));
    await expect(svc.submitDocument({ documentId: VAT_GROUP_DOC })).rejects.toMatchObject({ code: 'TAX_AUTHORITY_REJECTED' });
    expect(createSessionAndAlert).toHaveBeenCalledTimes(2);
  });

  test('alert delivery failures never replace the rejection', async () => {
    createSessionAndAlert.mockRejectedValueOnce(new Error('notification unavailable'));
    await expect(svc.submitDocument({ documentId: VAT_GROUP_DOC })).rejects.toMatchObject({ code: 'TAX_AUTHORITY_REJECTED' });
    await new Promise(resolve => setImmediate(resolve));
    expect(require('../app/telemetry/logger').error).toHaveBeenCalledWith('Failed to create Devin session for Sovos e-invoice demo', expect.objectContaining({ error: 'notification unavailable' }));
  });
});

describe('HTTP contract', () => {
  let server, port;
  beforeAll(done => {
    const app = express(); app.use(express.json()); app.use(router);
    server = app.listen(0, '127.0.0.1', () => { port = server.address().port; done(); });
  });
  afterAll(done => { server.close(done); });
  function request(method, url, body) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: url, method, headers: { 'Content-Type': 'application/json' } }, res => {
        let data = ''; res.on('data', c => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      });
      req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  test('document list exposes totals but not internal buyer classification', async () => {
    const res = await request('GET', '/api/7c9d826f/documents');
    expect(res.status).toBe(200); expect(res.body.documents).toHaveLength(4);
    expect(JSON.stringify(res.body)).not.toContain('vatGroupMember');
  });
  test('422 on the planted defect, 200 on the healthy document, 404 on unknown', async () => {
    expect(await request('POST', `/api/7c9d826f/documents/${VAT_GROUP_DOC}/submit`, { devinUserId: 'route-user', devinOrgId: 'route-org' })).toMatchObject({ status: 422, body: { success: false, code: 'TAX_AUTHORITY_REJECTED', errorClass: 'TaxAuthorityRejection' } });
    expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({ devinUserId: 'route-user', devinOrgId: 'route-org' }));
    expect(await request('POST', `/api/7c9d826f/documents/${STANDARD_DOC}/submit`)).toMatchObject({ status: 200, body: { success: true } });
    expect(await request('POST', '/api/7c9d826f/documents/nope/submit')).toMatchObject({ status: 404 });
  });
});
