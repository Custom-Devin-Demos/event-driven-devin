/* global describe, expect, test, beforeAll, afterAll, beforeEach */
const express = require('express');
const http = require('http');

const router = require('../app/routes/verticals/526efb4c');
const svc = require('../app/services/verticals/526efb4c');

let server;
let baseUrl;

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(`${baseUrl}${path}`, {
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : {} }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function isoYearsAgo(years, now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate()));
  return d.toISOString().slice(0, 10);
}

const VALID = {
  firstName: 'Jordan', middleName: 'Avery', lastName: 'Ellis', dateOfBirth: '1986-04-12',
  addressLine1: '1420 Harbor Ave SW', city: 'Seattle', country: 'US', state: 'WA', postCode: '98126',
  idType: 'ssn', ssn: '123-45-6789',
};
const SIGNATURE = { method: 'choose', name: 'Jordan Ellis', style: 1 };

async function cardSession(cardNumber = '378282246310005', cardId = '4321') {
  const r = await request('POST', '/api/526efb4c/session', { cardNumber, cardId });
  return r.body.sessionToken;
}

beforeAll((done) => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(router);
  server = http.createServer(app);
  server.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => {
  server.close(done);
});
beforeEach(() => svc.resetForTests());

describe('Amex Corporate KYC form shape (526efb4c)', () => {
  test('US form has three questionnaire steps, signature and thank-you copy', async () => {
    const r = await request('GET', '/api/526efb4c/form?market=US');
    expect(r.status).toBe(200);
    const { form } = r.body;
    expect(form.title).toBe('American Express\u00ae USA Corporate Program: Know Your Customer (KYC)');
    expect(form.intro.regulatoryNotice).toMatch(/USA PATRIOT Act/);
    expect(form.steps.map((s) => s.id)).toEqual(['legal-name', 'residential-address', 'national-id']);
    expect(form.signature.methods).toEqual(['draw', 'choose']);
    expect(form.thankYou.lines[0]).toBe('Your KYC information has been submitted successfully.');
    const types = new Set(form.steps.flatMap((s) => s.fields.map((f) => f.type)));
    for (const t of types) expect(['text', 'date', 'select', 'radio', 'file']).toContain(t);
  });

  test('defaults to US and stays US-specific (no nationality, birthplace, UBO or entity questions)', async () => {
    const r = await request('GET', '/api/526efb4c/form');
    const ids = r.body.form.steps.flatMap((s) => s.fields.map((f) => f.id));
    expect(ids).toEqual(expect.arrayContaining(['ssn', 'itin', 'state', 'postCode']));
    for (const banned of ['nationality', 'placeOfBirth', 'beneficialOwners', 'entityName', 'registrationNumber']) {
      expect(ids).not.toContain(banned);
    }
    const country = r.body.form.steps[1].fields.find((f) => f.id === 'country');
    expect(country.options).toHaveLength(249);
    expect(country.defaultValue).toBe('US');
    const state = r.body.form.steps[1].fields.find((f) => f.id === 'state');
    expect(state.options.map((o) => o.value)).toEqual(expect.arrayContaining(['WA', 'DC', 'PR', 'AE']));
  });

  test('FR is not yet available', async () => {
    const r = await request('GET', '/api/526efb4c/form?market=FR');
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ code: 'MARKET_NOT_AVAILABLE', error: 'KYC is not yet available for market FR', availableMarkets: ['US'] });
    expect((await request('GET', '/api/526efb4c/form?market=fr')).status).toBe(404);
    expect((await request('GET', '/api/526efb4c/form?market=FRA')).status).toBe(400);
  });
});

describe('login', () => {
  test('card login with the Corporate Green test card', async () => {
    const r = await request('POST', '/api/526efb4c/session', { cardNumber: '3782 822463 10005', cardId: '4321' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ method: 'card', needsCardSelection: false, card: { product: 'Corporate Green Card', masked: 'xxxx-xxxxxx-10005' } });
    expect(r.body.cardmember).toMatchObject({ firstName: 'Jordan', company: 'Harbor & Pine Coffee Roasters, Inc.' });
  });

  test('card format and wrong Card ID are rejected', async () => {
    const bad = await request('POST', '/api/526efb4c/session', { cardNumber: '4111111111111111', cardId: '12' });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.errors)).toEqual(['cardNumber', 'cardId']);
    const wrong = await request('POST', '/api/526efb4c/session', { cardNumber: '371449635398431', cardId: '4321' });
    expect(wrong.status).toBe(401);
  });

  test('My Account login then choose a card', async () => {
    const r = await request('POST', '/api/526efb4c/session', { method: 'account', userId: 'jordan.ellis', password: 'Corporate2026!' });
    expect(r.status).toBe(200);
    expect(r.body.needsCardSelection).toBe(true);
    expect(r.body.cards.map((c) => c.product)).toEqual(['Corporate Green Card', 'Corporate Platinum Card']);
    const sel = await request('POST', '/api/526efb4c/session/card', { sessionToken: r.body.sessionToken, cardKey: '98431' });
    expect(sel.status).toBe(200);
    expect(sel.body.card.product).toBe('Corporate Platinum Card');
    expect(sel.body.cards).toHaveLength(2);
    const back = await request('POST', '/api/526efb4c/session/card', { sessionToken: r.body.sessionToken, cardKey: '10005' });
    expect(back.body.card.product).toBe('Corporate Green Card');
    expect((await request('POST', '/api/526efb4c/session', { method: 'account', userId: 'jordan.ellis', password: 'nope' })).status).toBe(401);
  });

  test('login for an unavailable market is refused', async () => {
    const r = await request('POST', '/api/526efb4c/session', { market: 'FR', cardNumber: '378282246310005', cardId: '4321' });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('MARKET_NOT_AVAILABLE');
  });
});

describe('step validation rules', () => {
  const validate = (stepId, values) => svc.validateStep('US', stepId, values);

  test('legal name requires first/last name and an adult date of birth', () => {
    expect(validate('legal-name', {}).errors).toMatchObject({ firstName: expect.any(String), lastName: expect.any(String), dateOfBirth: expect.any(String) });
    expect(validate('legal-name', { firstName: 'Jo', lastName: 'Ellis', dateOfBirth: isoYearsAgo(17) }).errors.dateOfBirth).toMatch(/18/);
    expect(validate('legal-name', { firstName: 'Jo', lastName: 'Ellis', dateOfBirth: isoYearsAgo(18) }).valid).toBe(true);
    expect(validate('legal-name', { firstName: 'Jo', lastName: 'Ellis', dateOfBirth: '2026-02-30' }).valid).toBe(false);
  });

  test('P.O. Box and PMB addresses are rejected', () => {
    const base = { city: 'Seattle', country: 'US', state: 'WA', postCode: '98101' };
    for (const line of ['P.O. Box 123', 'PO Box 9', 'post office box 4', '500 Pine St PMB 12']) {
      expect(validate('residential-address', { ...base, addressLine1: line }).errors.addressLine1).toMatch(/P\.O\. Box/);
    }
    expect(validate('residential-address', { ...base, addressLine1: '12 Poblano Way' }).valid).toBe(true);
    expect(validate('residential-address', { ...base, addressLine1: '12 Main St', addressLine2: 'PMB 7' }).errors.addressLine2).toBeDefined();
  });

  test('US needs a state select and a 5-digit zip; other countries take free-text state and post code', () => {
    const us = validate('residential-address', { addressLine1: '1 Main St', city: 'Austin', country: 'US', region: 'Texas', postCode: '7870' });
    expect(us.errors).toMatchObject({ state: expect.any(String), postCode: 'Enter a 5-digit Zip code' });
    expect(us.errors.region).toBeUndefined();
    const ca = validate('residential-address', { addressLine1: '1 Bay St', city: 'Toronto', country: 'CA', region: 'Ontario', postCode: 'M5J 2N8' });
    expect(ca.valid).toBe(true);
    const caMissing = validate('residential-address', { addressLine1: '1 Bay St', city: 'Toronto', country: 'CA', postCode: 'M5J 2N8' });
    expect(Object.keys(caMissing.errors)).toEqual(['region']);
  });

  test('SSN and ITIN formats', () => {
    expect(validate('national-id', { idType: 'ssn', ssn: '123456789' }).valid).toBe(true);
    expect(validate('national-id', { idType: 'ssn', ssn: '000-12-3456' }).errors.ssn).toBeDefined();
    expect(validate('national-id', { idType: 'ssn', ssn: '912-70-1234' }).errors.ssn).toBeDefined();
    expect(validate('national-id', { idType: 'itin', itin: '912-70-1234' }).valid).toBe(true);
    expect(validate('national-id', { idType: 'itin', itin: '912-93-1234' }).errors.itin).toBeDefined();
    expect(validate('national-id', { idType: 'passport' }).errors.idType).toBeDefined();
  });

  test('foreign ID: not expired, expiry after issuance, PDF/JPG/PNG upload only', () => {
    const now = new Date();
    const future = `${now.getUTCFullYear() + 3}-01-15`;
    const ok = {
      idType: 'none', govIdType: 'foreign-passport', govIdNumber: 'P1234567', govIdIssueDate: '2022-01-15',
      govIdExpiryDate: future, govIdCountry: 'CA', govIdDocument: 'passport.pdf',
    };
    expect(validate('national-id', ok).valid).toBe(true);
    expect(validate('national-id', { ...ok, govIdExpiryDate: '2023-01-01' }).errors.govIdExpiryDate).toMatch(/expired/);
    expect(validate('national-id', { ...ok, govIdIssueDate: `${now.getUTCFullYear() + 4}-01-01` }).errors.govIdIssueDate).toMatch(/future/);
    expect(validate('national-id', { ...ok, govIdIssueDate: '2022-01-15', govIdExpiryDate: future, govIdDocument: 'passport.docx' }).errors.govIdDocument).toMatch(/PDF/);
    expect(validate('national-id', { ...ok, govIdDocument: '' }).errors.govIdDocument).toMatch(/required/);
  });

  test('conditional fields: hidden fields are neither required nor validated', () => {
    const form = svc.getForm('US');
    const fields = form.steps[2].fields;
    const visible = (values) => fields.filter((f) => svc.isVisible(f, values)).map((f) => f.id);
    expect(visible({ idType: 'ssn' })).toEqual(['idType', 'ssn']);
    expect(visible({ idType: 'itin' })).toEqual(['idType', 'itin']);
    expect(visible({ idType: 'none' })).toEqual(['idType', 'govIdType', 'govIdNumber', 'govIdIssueDate', 'govIdExpiryDate', 'govIdCountry', 'govIdDocument']);
    expect(validate('national-id', { idType: 'ssn', ssn: '123-45-6789', itin: 'garbage' }).valid).toBe(true);
  });

  test('validate endpoint returns field errors and 404s unknown steps and markets', async () => {
    const r = await request('POST', '/api/526efb4c/steps/legal-name/validate', { market: 'US', values: { firstName: 'Jordan' } });
    expect(r.status).toBe(200);
    expect(r.body.valid).toBe(false);
    expect(Object.keys(r.body.errors)).toEqual(['lastName', 'dateOfBirth']);
    expect((await request('POST', '/api/526efb4c/steps/nope/validate', { values: {} })).status).toBe(404);
    expect((await request('POST', '/api/526efb4c/steps/legal-name/validate', { market: 'FR', values: {} })).status).toBe(404);
  });
});

describe('submission', () => {
  test('re-validates everything, requires a signature, redacts the SSN and blocks resubmission', async () => {
    const token = await cardSession();
    const noSig = await request('POST', '/api/526efb4c/submissions', { sessionToken: token, values: VALID });
    expect(noSig.status).toBe(400);
    expect(noSig.body.code).toBe('SIGNATURE_REQUIRED');

    const invalid = await request('POST', '/api/526efb4c/submissions', { sessionToken: token, values: { ...VALID, addressLine1: 'PO Box 1' }, signature: SIGNATURE });
    expect(invalid.status).toBe(400);
    expect(invalid.body.errors['residential-address'].addressLine1).toBeDefined();

    const ok = await request('POST', '/api/526efb4c/submissions', { sessionToken: token, values: VALID, signature: SIGNATURE });
    expect(ok.status).toBe(201);
    expect(ok.body.reference).toMatch(/^KYC-[0-9A-F]{8}$/);
    expect(ok.body.answers.ssn).toBe('***-**-6789');
    expect(JSON.stringify(ok.body)).not.toContain('123-45-6789');
    expect(ok.body.answers.itin).toBeUndefined();

    const again = await request('POST', '/api/526efb4c/submissions', { sessionToken: token, values: VALID, signature: SIGNATURE });
    expect(again.status).toBe(409);
    expect(again.body.reference).toBe(ok.body.reference);
  });

  test('drawn signature and ITIN redaction', async () => {
    const token = await cardSession('371449635398431', '8765');
    const values = { ...VALID, idType: 'itin', ssn: undefined, itin: '912701234' };
    const r = await request('POST', '/api/526efb4c/submissions', {
      sessionToken: token, values, signature: { method: 'draw', image: 'data:image/png;base64,iVBORw0KGgo=' },
    });
    expect(r.status).toBe(201);
    expect(r.body.answers.itin).toBe('***-**-1234');
    expect(r.body.signatureMethod).toBe('draw');
  });

  test('submissions are retired with their session so the store stays bounded', () => {
    const { sessionToken } = svc.login({ cardNumber: '378282246310005', cardId: '4321' });
    expect(svc.submit({ sessionToken, values: VALID, signature: SIGNATURE }).status).toBe(201);
    expect(svc.storeSizes().submissions).toBe(1);
    for (let i = 0; i < 500; i++) svc.login({ cardNumber: '378282246310005', cardId: '4321' });
    expect(svc.storeSizes().sessions).toBeLessThanOrEqual(500);
    expect(svc.storeSizes().submissions).toBe(0);
  });

  test('requires a session with a selected card', async () => {
    expect((await request('POST', '/api/526efb4c/submissions', { sessionToken: 'nope', values: VALID, signature: SIGNATURE })).status).toBe(401);
    const acct = await request('POST', '/api/526efb4c/session', { method: 'account', userId: 'jordan.ellis', password: 'Corporate2026!' });
    const r = await request('POST', '/api/526efb4c/submissions', { sessionToken: acct.body.sessionToken, values: VALID, signature: SIGNATURE });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('CARD_NOT_SELECTED');
  });
});
