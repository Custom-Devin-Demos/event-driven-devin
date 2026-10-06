const fs = require('fs');
const path = require('path');
const express = require('express');

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

jest.mock('../app/telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { submitInspection, FACILITIES } = require('../app/services/verticals/059b9215');
const inspectionRouter = require('../app/routes/verticals/059b9215');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
const { ONCALL_SKINS } = require('../config/oncall-skins');
const { BUG_CATALOG, SEV1_INCIDENTS, isValidIncidentCopy, getSev1ChatterVocabulary, buildSev1IncidentCopy } = require('../app/services/oncall');
const oncallRoutes = require('../app/routes/oncall');

const PAGE = fs.readFileSync(path.join(__dirname, '../app/public/verticals/059b9215.html'), 'utf8');

describe('inspection result submission (059b9215)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('submitting an inspection result fails with a TypeError and raises one Inspection Report alert', async () => {
    await expect(submitInspection({ facilityId: 'FAC-2041', inspectionType: 'monthly', value: 460 })).rejects.toThrow(TypeError);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException.mock.calls[0][1].tags).toMatchObject({
      route: '/api/059b9215/inspection',
      service: 'inspection-report-api',
      alert_path: 'instant',
    });

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.verticalLabel).toBe('Inspection Report');
    expect(alert.service).toBe('inspection-report-api');
    expect(alert.errorType).toBe('TypeError');
    expect(alert.culprit).toContain('app/services/verticals/059b9215.js');
    expect(alert.culprit).not.toContain('insurance');
  });

  test('the Sentry webhook treats the inspection failure as already alerted', () => {
    expect(isInstantPathEvent({ culprit: 'app/services/verticals/059b9215.js — submitInspection', tags: [] })).toBe(true);
  });

  describe('routes', () => {
    let server;
    let base;

    beforeAll(async () => {
      const app = express();
      app.use(express.json());
      app.use(inspectionRouter);
      await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
      base = `http://127.0.0.1:${server.address().port}`;
    });

    afterAll(() => new Promise((resolve) => server.close(resolve)));

    test('POST /api/059b9215/inspection returns the inspection failure, not a claim one', async () => {
      const res = await fetch(`${base}/api/059b9215/inspection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ facilityId: 'FAC-2187', inspectionType: 'special', value: 1180, inspectedOn: '2026-10-05', notes: '' }),
      });
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.errorClass).toBe('TypeError');
      expect(body.code).toBe('INSPECTION_SUBMIT_FAILED');
      expect(JSON.stringify(body)).not.toMatch(/claim|policy/i);
    });

    test('GET /api/059b9215/facilities lists the facilities under contract', async () => {
      const res = await fetch(`${base}/api/059b9215/facilities`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.facilities.map((f) => f.id).sort()).toEqual(Object.keys(FACILITIES).sort());
      expect(body.inspectionTypes.map((t) => t.id)).toContain('monthly');
    });
  });

  describe('skin', () => {
    const skin = ONCALL_SKINS['059b9215'];

    test('backs the page with the insurance scenario and the insurance-claims SEV-1 story', () => {
      expect(skin.vertical).toBe('insurance');
      expect(skin.page.file).toBe('059b9215.html');
      expect(skin.incident.kind).toBe('insurance-claims');
      expect(skin.disclaimer).toMatch(/^NOT ACTUALLY A RYOYO SYSTEMS SITE/);
      expect(skin.disclaimer).not.toMatch(/internal/i);
    });

    test('incident vocabulary leaves the truthful telemetry surface alone', () => {
      const sources = Object.keys(skin.incident.chatter.vocabulary);
      expect(sources.some((s) => /insurance-api|\/api\/oncall|504|monitor/i.test(s))).toBe(false);
    });
  });

  describe('bug portal + console localization', () => {
    const skin = ONCALL_SKINS['059b9215'];
    const JP = /[\u3040-\u30ff\u4e00-\u9fff]/;

    test('offers one TENLOG product area whose templates are real insurance catalog ids, written in Japanese', () => {
      const products = skin.bugPortal.products;
      expect(products).toHaveLength(1);
      expect(products[0].area).toBe(skin.vertical);
      expect(products[0].label).toMatch(JP);
      expect(products[0].persona.name).toMatch(JP);
      const catalogIds = BUG_CATALOG.insurance.map((t) => t.id);
      for (const template of products[0].templates) {
        expect(catalogIds).toContain(template.id);
        expect(template.label).toMatch(JP);
        expect(template.text).toMatch(JP);
        expect(template.text).not.toMatch(/claim|policy|insur|保険/i);
        expect(template.text).not.toMatch(/vendor|adjudicat|upstream|依存/i);
      }
    });

    test('localizes the shared report portal and SEV-1 console UI strings without touching other skins', () => {
      expect(isValidIncidentCopy(skin.bugPortal.copy)).toBe(true);
      expect(skin.bugPortal.copy.lang).toBe('ja');
      expect(skin.bugPortal.copy.submitButton).toBe('報告を送信');
      expect(skin.bugPortal.copy.asideTipStatus).toContain('{link}');
      expect(skin.bugPortal.copy.submittedSkippedActivated).toContain('{minutes}');
      expect(isValidIncidentCopy(skin.incident.copy)).toBe(true);
      expect(skin.incident.copy.lang).toBe('ja');
      const story = SEV1_INCIDENTS['insurance-claims'];
      const copy = buildSev1IncidentCopy(story, getSev1ChatterVocabulary(story, skin, 'insurance-claims'));
      expect(copy.label).toBe('点検結果の提出が失敗 — insurance-api 504s');
      expect(copy.title).toContain('504 Gateway Timeout on insurance-api');
      expect(copy.summary).toContain('POST /api/oncall/insurance/claim');
      expect(copy.summary).toContain('504');
      expect(copy.summary).toContain('現場の点検員はポータルから点検結果を提出できません');
      expect(copy.summary).not.toMatch(/claim submissions|policyholders/i);
      expect(story.label).toBe('Claim submissions failing — insurance-api 504s');
      expect(ONCALL_SKINS['63dbb52f'].bugPortal.copy).toBeUndefined();
      expect(ONCALL_SKINS['e7c9dc7a'].incident.copy).toBeUndefined();
    });

    describe('report route', () => {
      let server;
      let baseUrl;
      beforeAll(async () => {
        const app = express();
        app.use(express.json());
        app.use(oncallRoutes);
        await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
      });
      afterAll((done) => { server.close(done); });

      test('/oncall/c/059b9215/report serves the portal with the skin and its Japanese copy', async () => {
        const res = await fetch(`${baseUrl}/oncall/c/059b9215/report`);
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain('window.ONCALL_SKIN');
        expect(html).toContain('insurance-claim-timeout');
        expect(html).toContain('サポートリクエストの送信');
        expect(html).toContain('id="hero-title"');
      });

      test('the generic /oncall/report keeps its English defaults and no skin', async () => {
        const res = await fetch(`${baseUrl}/oncall/report`);
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).not.toContain('window.ONCALL_SKIN =');
        expect(html).toContain('<h1 id="hero-title">Submit a support request</h1>');
        expect(html).not.toMatch(JP);
      });
    });
  });

  describe('page', () => {
    test('keeps the insurance form ids and submits to the inspection API when bare, the claim API under the on-call shim', () => {
      ['claimForm', 'policyId', 'claimType', 'amount', 'description', 'submitBtn', 'result'].forEach((id) => {
        expect(PAGE).toContain(`id="${id}"`);
      });
      expect(PAGE).toContain("var shimmed = !!document.getElementById('oncall-unique');");
      expect(PAGE).toContain("shimmed ? '/api/insurance/claim' : '/api/059b9215/inspection'");
      expect(PAGE).toContain('policyId: facility.contract,');
      expect(PAGE).not.toContain("fetch('/api/insurance/claim'");
      expect(PAGE).toContain('<title>点検結果の提出 - 点検クラウド TENLOG | 菱陽システムズ</title>');
    });
  });
});
