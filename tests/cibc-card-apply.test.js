/* global describe, expect, test */

const express = require('express');
const http = require('http');

const cibcCardApply = require('../app/routes/cibc-card-apply');
const { normaliseAddress, formatPostalCode } = require('../src/application/addressNormaliser');

function postApplication(body) {
  const app = express();
  app.use(express.json());
  app.use(cibcCardApply);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/cibc-card-apply/applications',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => { raw += chunk; });
          res.on('end', () => {
            server.close(() => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
          });
        },
      );
      req.on('error', (error) => server.close(() => reject(error)));
      req.end(payload);
    });
  });
}

const VALID_FORM = {
  firstName: 'Amrita',
  lastName: 'Sandhu',
  dateOfBirth: '1988-04-12',
  email: 'Amrita.Sandhu@Example.com',
  phone: '(416) 555-0148',
  street: '  199 Bay Street ',
  unit: ' ph 4b ',
  city: ' Toronto ',
  province: 'on',
  postalCode: 'm5l1a2',
};

describe('normaliseAddress', () => {
  test('normalises a full address including an apt/unit value', () => {
    const result = normaliseAddress({
      street: '  199 Bay Street ',
      unit: ' ph 4b ',
      city: ' Toronto ',
      province: 'on',
      postalCode: 'm5l 1a2',
    });

    expect(result).toEqual({
      street: '199 BAY STREET',
      unit: 'PH 4B',
      city: 'TORONTO',
      province: 'ON',
      postalCode: 'M5L 1A2',
      country: 'CA',
    });
  });

  test('formats postal codes into the A1A 1A1 presentation form', () => {
    expect(formatPostalCode('m5l1a2')).toBe('M5L 1A2');
    expect(formatPostalCode('m5l-1a2')).toBe('M5L 1A2');
    expect(formatPostalCode(' M5L 1A2 ')).toBe('M5L 1A2');

    const result = normaliseAddress({
      street: '81 Bay St',
      unit: '2200',
      city: 'Toronto',
      province: 'ON',
      postalCode: ' m5j0e7 ',
    });
    expect(result.postalCode).toBe('M5J 0E7');
  });

  test('rejects a non-object input', () => {
    expect(() => normaliseAddress(null)).toThrow(TypeError);
  });
});

describe('POST /api/cibc-card-apply/applications', () => {
  test('rejects a submission that is missing required fields', async () => {
    const { status, body } = await postApplication({
      firstName: 'Amrita',
      email: 'not-an-email',
      province: 'on',
      postalCode: 'm5l1a2',
    });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(Object.keys(body.errors).sort()).toEqual([
      'city', 'dateOfBirth', 'email', 'lastName', 'phone', 'street',
    ]);
    expect(body.errors.email).toMatch(/valid email/i);
  });

  test('rejects an invalid postal code', async () => {
    const { status, body } = await postApplication({ ...VALID_FORM, postalCode: '12345' });

    expect(status).toBe(400);
    expect(body.errors.postalCode).toMatch(/postal code/i);
  });

  test('accepts a complete submission and returns the normalised application', async () => {
    const { status, body } = await postApplication(VALID_FORM);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.referenceNumber).toMatch(/^CC-[0-9A-F]{8}$/);
    expect(body.nextStep).toEqual({ step: 2, label: 'Employment and income' });
    expect(body.application.applicant).toEqual({
      firstName: 'Amrita',
      lastName: 'Sandhu',
      dateOfBirth: '1988-04-12',
      email: 'amrita.sandhu@example.com',
      phone: '4165550148',
    });
    expect(body.application.address).toEqual({
      street: '199 BAY STREET',
      unit: 'PH 4B',
      city: 'TORONTO',
      province: 'ON',
      postalCode: 'M5L 1A2',
      country: 'CA',
    });
  });
});
