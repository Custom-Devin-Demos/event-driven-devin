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

  test('markets other than US and FR are not yet available', async () => {
    const r = await request('GET', '/api/526efb4c/form?market=DE');
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ code: 'MARKET_NOT_AVAILABLE', error: 'KYC is not yet available for market DE', availableMarkets: ['US', 'FR'] });
    expect((await request('GET', '/api/526efb4c/form?market=de')).status).toBe(404);
    expect((await request('GET', '/api/526efb4c/form?market=FRA')).status).toBe(400);
  });

  test('US journey keeps exactly the same steps and fields', async () => {
    const r = await request('GET', '/api/526efb4c/form?market=US');
    expect(r.body.form.steps.map((s) => [s.id, s.fields.map((f) => f.id)])).toEqual([
      ['legal-name', ['firstName', 'middleName', 'lastName', 'dateOfBirth']],
      ['residential-address', ['addressLine1', 'addressLine2', 'city', 'country', 'state', 'region', 'postCode']],
      ['national-id', ['idType', 'ssn', 'itin', 'govIdType', 'govIdNumber', 'govIdIssueDate', 'govIdExpiryDate', 'govIdCountry', 'govIdDocument']],
    ]);
    expect(r.body.form.intro.privacyNotice).toBeUndefined();
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
    const r = await request('POST', '/api/526efb4c/session', { market: 'DE', cardNumber: '378282246310005', cardId: '4321' });
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
    expect((await request('POST', '/api/526efb4c/steps/legal-name/validate', { market: 'DE', values: {} })).status).toBe(404);
    expect((await request('POST', '/api/526efb4c/steps/national-id/validate', { market: 'FR', values: {} })).status).toBe(404);
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

const FR_VALID = {
  firstName: 'Jordan', middleName: 'Avery', lastName: 'Ellis', usageName: 'Martin', dateOfBirth: '1986-04-12',
  birthCity: 'Lyon', birthCountry: 'FR',
  nationalityStatus: 'national', nationality: 'FR', hasOtherNationality: 'yes', secondNationality: 'US',
  addressLine1: '18 rue de la Paix', city: 'Paris', country: 'FR', postCode: '75002',
  idDocumentType: 'fr-passport', idDocumentNumber: '18AB12345', idIssueDate: '2022-03-01',
  idExpiryDate: `${new Date().getUTCFullYear() + 5}-03-01`, idDocument: 'passport.pdf', taxIdNumber: '1234567890123',
  occupation: 'manager', jobTitle: 'Head of Purchasing', employerSiren: '842 917 361',
  pepStatus: 'no',
};

describe('France (FR) market', () => {
  const validate = (stepId, values) => svc.validateStep('FR', stepId, values);
  const errs = (stepId, values) => validate(stepId, { ...FR_VALID, ...values }).errors;

  test('form has the AMLR-driven steps, EU notice and no US identifiers', async () => {
    const r = await request('GET', '/api/526efb4c/form?market=fr');
    expect(r.status).toBe(200);
    const { form } = r.body;
    expect(form.code).toBe('FR');
    expect(form.title).toBe('American Express\u00ae France Corporate Program: Know Your Customer (KYC)');
    expect(form.intro.regulatoryNotice).toMatch(/Regulation \(EU\) 2024\/1624/);
    expect(form.intro.regulatoryNotice).not.toMatch(/PATRIOT/);
    expect(form.intro.privacyNotice).toMatch(/NIR/);
    expect(form.steps.map((s) => s.id)).toEqual(['legal-name', 'nationality', 'residential-address', 'identity-document', 'occupation', 'pep']);
    const ids = form.steps.flatMap((s) => s.fields.map((f) => f.id));
    for (const id of ['usageName', 'birthCity', 'birthCountry', 'nationalityStatus', 'secondNationality', 'furtherNationalities', 'idDocumentType', 'taxIdNumber', 'employerSiren', 'pepStatus']) {
      expect(ids).toContain(id);
    }
    for (const banned of ['ssn', 'itin', 'idType']) expect(ids).not.toContain(banned);
    const address = form.steps[2].fields;
    expect(address.find((f) => f.id === 'country').defaultValue).toBe('FR');
  });

  test('every FR step accepts the reference answers', () => {
    for (const step of svc.getForm('FR').steps) expect(validate(step.id, FR_VALID)).toEqual({ valid: true, errors: {} });
  });

  test('legal name: birth surname, place of birth and optional surname of use', () => {
    expect(validate('legal-name', {}).errors).toMatchObject({
      firstName: expect.any(String), lastName: expect.any(String), dateOfBirth: expect.any(String),
      birthCity: expect.any(String), birthCountry: expect.any(String),
    });
    expect(errs('legal-name', { usageName: '' }).usageName).toBeUndefined();
    expect(errs('legal-name', { usageName: 'M4rtin' }).usageName).toMatch(/letters/);
    expect(errs('legal-name', { birthCity: 'Saint-Étienne' }).birthCity).toBeUndefined();
    expect(errs('legal-name', { birthCity: '75001' }).birthCity).toMatch(/letters/);
    expect(errs('legal-name', { birthCountry: 'XX' }).birthCountry).toMatch(/valid/);
  });

  test('nationality: all nationalities, distinct, or stateless / protection status', () => {
    expect(validate('nationality', {}).errors).toEqual({ nationalityStatus: 'Nationality status is required' });
    expect(Object.keys(validate('nationality', { nationalityStatus: 'national' }).errors)).toEqual(['nationality', 'hasOtherNationality']);
    expect(errs('nationality', { secondNationality: '' }).secondNationality).toMatch(/required/);
    expect(errs('nationality', { secondNationality: 'FR' }).secondNationality).toMatch(/already/);
    expect(errs('nationality', { thirdNationality: 'US' }).thirdNationality).toMatch(/already/);
    expect(errs('nationality', { thirdNationality: 'DE' }).thirdNationality).toBeUndefined();
    expect(errs('nationality', { thirdNationality: 'CA', furtherNationalities: 'Belgium, it, Switzerland' })).toEqual({});
    expect(errs('nationality', { thirdNationality: 'CA', furtherNationalities: 'BE, Narnia' }).furtherNationalities).toMatch(/Narnia/);
    expect(errs('nationality', { thirdNationality: 'CA', furtherNationalities: 'canada' }).furtherNationalities).toMatch(/already/);
    expect(errs('nationality', { furtherNationalities: 'BE, Belgium' }).furtherNationalities).toMatch(/already/);
    expect(validate('nationality', { nationalityStatus: 'national', nationality: 'FR', hasOtherNationality: 'no', secondNationality: 'FR' }).valid).toBe(true);
    expect(Object.keys(validate('nationality', { nationalityStatus: 'refugee' }).errors)).toEqual(['protectionCountry']);
    expect(validate('nationality', { nationalityStatus: 'subsidiary-protection', protectionCountry: 'FR' }).valid).toBe(true);
    expect(validate('nationality', { nationalityStatus: 'stateless' }).valid).toBe(true);
    expect(validate('nationality', { nationalityStatus: 'dual' }).errors.nationalityStatus).toMatch(/valid/);
  });

  test('a field whose controlling field is hidden is neither required nor validated', () => {
    const values = { nationalityStatus: 'stateless', hasOtherNationality: 'yes', secondNationality: 'garbage' };
    expect(validate('nationality', values).valid).toBe(true);
    const fields = svc.getForm('FR').steps[1].fields;
    const byId = Object.fromEntries(fields.map((f) => [f.id, f]));
    const visible = fields.filter((f) => svc.isVisible(f, values, byId)).map((f) => f.id);
    expect(visible).toEqual(['nationalityStatus']);
    expect(validate('nationality', { ...values, furtherNationalities: 'Narnia' }).valid).toBe(true);
  });

  test('residence: French post codes per territory and no BP / CS / TSA / CEDEX addresses', () => {
    for (const line of ['BP 45', 'B.P. 12', '10 avenue Foch CS 70001', 'TSA 30001', '75008 Paris Cedex 08', 'Poste restante', 'Boîte postale 7', 'PO Box 9']) {
      expect(errs('residential-address', { addressLine1: line }).addressLine1).toMatch(/residential address/);
    }
    expect(errs('residential-address', { addressLine1: '3 rue des Capucines' }).addressLine1).toBeUndefined();
    expect(errs('residential-address', { addressLine2: 'CEDEX 9' }).addressLine2).toBeDefined();
    expect(errs('residential-address', { postCode: '7500' }).postCode).toMatch(/French post code/);
    expect(errs('residential-address', { postCode: '00123' }).postCode).toBeDefined();
    expect(errs('residential-address', { postCode: '97110' }).postCode).toBeDefined();
    expect(errs('residential-address', { postCode: '20000' }).postCode).toBeUndefined();
    expect(errs('residential-address', { country: 'GP', postCode: '97110' })).toEqual({});
    expect(errs('residential-address', { country: 'GP', postCode: '75002' }).postCode).toBeDefined();
    expect(errs('residential-address', { country: 'DE', postCode: '10115' })).toEqual({ region: 'State / Province / Region is required' });
    expect(errs('residential-address', { country: 'DE', region: 'Berlin', postCode: '10115' })).toEqual({});
    expect(errs('residential-address', { country: 'US', postCode: '9812' })).toMatchObject({ state: expect.any(String), postCode: 'Enter a 5-digit Zip code' });
  });

  test('identity document: French document formats, issuing country, dates and upload', () => {
    expect(errs('identity-document', { idDocumentType: 'fr-cni', idDocumentNumber: 'X4RTBPFW4' }).idDocumentNumber).toBeUndefined();
    expect(errs('identity-document', { idDocumentType: 'fr-cni', idDocumentNumber: '880692310285' }).idDocumentNumber).toBeUndefined();
    expect(errs('identity-document', { idDocumentType: 'fr-cni', idDocumentNumber: 'AB12' }).idDocumentNumber).toMatch(/exactly/);
    expect(errs('identity-document', { idDocumentNumber: '18 ab 12345' }).idDocumentNumber).toBeUndefined();
    expect(errs('identity-document', { idDocumentNumber: '123456789' }).idDocumentNumber).toMatch(/exactly/);
    expect(errs('identity-document', { idDocumentType: 'fr-residence-permit', idDocumentNumber: '1234567890' }).idDocumentNumber).toBeUndefined();
    expect(errs('identity-document', { idDocumentType: 'eu-eea-id', idDocumentNumber: 'T22000129' }).idIssuingCountry).toMatch(/required/);
    expect(errs('identity-document', { idDocumentType: 'eu-eea-id', idDocumentNumber: 'T22000129', idIssuingCountry: 'US' }).idIssuingCountry).toMatch(/EU or EEA/);
    expect(errs('identity-document', { idDocumentType: 'eu-eea-id', idDocumentNumber: 'T22000129', idIssuingCountry: 'DE' })).toEqual({});
    expect(errs('identity-document', { idDocumentType: 'foreign-passport', idDocumentNumber: 'P1234567', idIssuingCountry: 'FR' }).idIssuingCountry).toMatch(/French passport/);
    expect(errs('identity-document', { idDocumentType: 'foreign-passport', idDocumentNumber: 'P1234567', idIssuingCountry: 'CA' })).toEqual({});
    expect(errs('identity-document', { idDocumentType: 'driving-licence' }).idDocumentType).toMatch(/valid/);
    expect(errs('identity-document', { idExpiryDate: '2023-01-01' }).idExpiryDate).toMatch(/expired/);
    expect(errs('identity-document', { idIssueDate: `${new Date().getUTCFullYear() + 1}-01-01` }).idIssueDate).toMatch(/future/);
    expect(errs('identity-document', { idDocument: 'scan.heic' }).idDocument).toMatch(/PDF/);
    expect(errs('identity-document', { taxIdNumber: '' }).taxIdNumber).toBeUndefined();
    expect(errs('identity-document', { taxIdNumber: '1234 5678 90123' }).taxIdNumber).toBeUndefined();
    expect(errs('identity-document', { taxIdNumber: '9234567890123' }).taxIdNumber).toMatch(/13-digit/);
  });

  test('occupation: select, job title and employer SIREN with Luhn check', () => {
    expect(Object.keys(validate('occupation', {}).errors)).toEqual(['occupation', 'jobTitle', 'employerSiren']);
    expect(errs('occupation', { occupation: 'astronaut' }).occupation).toMatch(/valid/);
    expect(errs('occupation', { jobTitle: '<script>' }).jobTitle).toMatch(/valid/);
    expect(errs('occupation', { employerSiren: '842917360' }).employerSiren).toMatch(/SIREN/);
    expect(errs('occupation', { employerSiren: '84291736' }).employerSiren).toMatch(/SIREN/);
  });

  test('PEP declaration: function, country, related person and end date when relevant', () => {
    expect(validate('pep', {}).errors).toEqual({ pepStatus: 'Which of the following applies to you? is required' });
    expect(validate('pep', { pepStatus: 'no', pepFunction: '<x>' }).valid).toBe(true);
    expect(Object.keys(validate('pep', { pepStatus: 'pep' }).errors)).toEqual(['pepFunction', 'pepCountry']);
    expect(Object.keys(validate('pep', { pepStatus: 'former-pep' }).errors)).toEqual(['pepFunction', 'pepCountry', 'pepEndDate']);
    expect(Object.keys(validate('pep', { pepStatus: 'family' }).errors)).toEqual(['pepRelatedName', 'pepFunction', 'pepCountry']);
    expect(validate('pep', { pepStatus: 'former-pep', pepFunction: 'Member of Parliament', pepCountry: 'FR', pepEndDate: `${new Date().getUTCFullYear() + 1}-01-01` }).errors.pepEndDate).toMatch(/future/);
    expect(validate('pep', { pepStatus: 'associate', pepRelatedName: 'Camille Durand', pepFunction: 'Ambassador', pepCountry: 'BE' }).valid).toBe(true);
  });

  test('FR card login, end-to-end submission with redacted tax ID and market lock', async () => {
    const login = await request('POST', '/api/526efb4c/session', { market: 'FR', cardNumber: '378282246310005', cardId: '4321' });
    expect(login.status).toBe(200);
    expect(login.body.market).toBe('FR');
    const token = login.body.sessionToken;

    const mismatch = await request('POST', '/api/526efb4c/submissions', { sessionToken: token, market: 'US', values: VALID, signature: SIGNATURE });
    expect(mismatch.body.code).toBe('MARKET_MISMATCH');

    const invalid = await request('POST', '/api/526efb4c/submissions', { sessionToken: token, market: 'FR', values: { ...FR_VALID, pepStatus: 'pep' }, signature: SIGNATURE });
    expect(invalid.status).toBe(400);
    expect(Object.keys(invalid.body.errors)).toEqual(['pep']);

    const ok = await request('POST', '/api/526efb4c/submissions', {
      sessionToken: token, market: 'FR', values: { ...FR_VALID, furtherNationalities: 'BE, CA', ssn: '123-45-6789', protectionCountry: 'FR' }, signature: SIGNATURE,
    });
    expect(ok.status).toBe(201);
    expect(ok.body.market).toBe('FR');
    expect(ok.body.answers).toMatchObject({ birthCity: 'Lyon', secondNationality: 'US', furtherNationalities: 'BE, CA', employerSiren: '842 917 361', taxIdNumber: '***-**-0123' });
    expect(JSON.stringify(ok.body)).not.toContain('1234567890123');
    expect(ok.body.answers.ssn).toBeUndefined();
    expect(ok.body.answers.protectionCountry).toBeUndefined();
  });

  test('FR step validate endpoint', async () => {
    const r = await request('POST', '/api/526efb4c/steps/occupation/validate', { market: 'FR', values: { occupation: 'employee', jobTitle: 'Buyer', employerSiren: '123456789' } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ valid: false, errors: { employerSiren: 'Enter a valid 9-digit SIREN number' } });
  });
});
