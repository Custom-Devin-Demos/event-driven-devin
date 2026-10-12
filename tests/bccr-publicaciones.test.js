/* global describe, expect, test, jest, beforeEach */

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

const express = require('express');
const http = require('http');
const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const {
  descargarPublicacion,
  listPublicaciones,
  PUBLICACIONES,
  TEMAS,
  ValidationError,
} = require('../app/services/verticals/bccr');
const bccrRoutes = require('../app/routes/verticals/bccr');
const bccrCustomer = require('../config/customers/bccr');
const { getCustomerConfig } = require('../config/customers');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');

const NEWEST = [...PUBLICACIONES].sort((a, b) => b.fecha.localeCompare(a.fecha))[0];
const OLDER = PUBLICACIONES.find((p) => p.id === 'pib-cantonal-presentacion-conferencia');
const IDENTITY = {
  devinUserId: 'user-abc123',
  devinOrgId: 'org-xyz789',
  devinEmail: 'antonio@devindemos.com',
};

function request(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use(bccrRoutes);

  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const payload = body === undefined ? '' : JSON.stringify(body);
      const headers = {};
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      const req = http.request({
        hostname: '127.0.0.1',
        port: server.address().port,
        path,
        method,
        headers,
      }, (res) => {
        let responseBody = '';
        res.on('data', (chunk) => { responseBody += chunk; });
        res.on('end', () => {
          const contentType = res.headers['content-type'] || '';
          const response = {
            status: res.statusCode,
            body: contentType.includes('application/json') ? JSON.parse(responseBody) : responseBody,
            contentType,
          };
          server.close(() => resolve(response));
        });
      });
      req.on('error', (error) => server.close(() => reject(error)));
      req.end(payload);
    });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('BCCR Sector Real catalog', () => {
  test('lists the 31 Sector Real publications with Spanish topics', () => {
    const data = listPublicaciones();
    expect(data.seccion).toBe('Sector Real');
    expect(data.publicaciones).toHaveLength(31);
    expect(data.temas.map((t) => t.label)).toContain('PIB y sector externo');
    expect(NEWEST.titulo).toMatch(/^Informe sobre el acceso de las micro, pequeñas y medianas/);
    expect(NEWEST.fecha).toBe('2023-09-29');
  });

  test('every publication links to the BCCR document library', () => {
    PUBLICACIONES.forEach((p) => {
      expect(p.link).toMatch(/^https:\/\/www\.bccr\.fi\.cr\/content\/dam\/bccr\/publicaciones\/sector-real\//);
    });
  });

  test('older publications resolve their topic and download', async () => {
    const result = await descargarPublicacion({ publicacionId: OLDER.id, ...IDENTITY });
    expect(result).toMatchObject({
      success: true,
      publicacionId: OLDER.id,
      url: OLDER.link,
      tema: TEMAS[OLDER.tema].label,
      formato: 'PDF',
    });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('unknown publication is a validation error, not an alert', async () => {
    await expect(descargarPublicacion({ publicacionId: 'no-existe' })).rejects.toBeInstanceOf(ValidationError);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});

describe('BCCR newest publication download failure', () => {
  test('throws a TypeError, reports to Sentry and raises a Spanish alert for the clicking user', async () => {
    await expect(descargarPublicacion({ publicacionId: NEWEST.id, ...IDENTITY })).rejects.toThrow(
      "Cannot read properties of undefined (reading 'carpeta')",
    );

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('bccr');
    expect(alert.errorType).toBe('TypeError');
    expect(alert.culprit).toContain('descargarPublicacion');
    expect(alert.devinUserId).toBe(IDENTITY.devinUserId);
    expect(alert.devinOrgId).toBe(IDENTITY.devinOrgId);
    expect(alert.devinEmail).toBe(IDENTITY.devinEmail);
    expect(alert.slackMemberId).toBeUndefined();
    expect(alert.slackMemberIdFallback).toBeUndefined();
    expect(alert.verticalLabel).toMatch(/^BCCR — Descarga/);
    expect(alert.promptAppendix).toContain('Repositorio a investigar y corregir');
    expect(alert.promptAppendix).toContain('/bccr');
  });

  test('customer config opts into the Spanish alert locale', () => {
    expect(bccrCustomer.locale).toBe('es');
    expect(getCustomerConfig('bccr').locale).toBe('es');
    expect(getCustomerConfig('t1').locale).toBe('en');
  });

  test('sentry webhook treats BCCR events as instant-path', () => {
    expect(isInstantPathEvent({
      tags: [],
      culprit: 'app/services/verticals/bccr.js — descargarPublicacion',
    })).toBe(true);
  });
});

describe('BCCR routes', () => {
  test('GET /bccr serves the Spanish page', async () => {
    const res = await request('GET', '/bccr');
    expect(res.status).toBe(200);
    expect(res.body).toContain('<html lang="es">');
    expect(res.body).toContain('Sector Real');
  });

  test('GET /api/bccr/publicaciones returns the catalog', async () => {
    const res = await request('GET', '/api/bccr/publicaciones');
    expect(res.status).toBe(200);
    expect(res.body.publicaciones).toHaveLength(31);
  });

  test('POST /api/bccr/descargas returns 500 for the newest publication and forwards identity', async () => {
    const res = await request('POST', '/api/bccr/descargas', { publicacionId: NEWEST.id, ...IDENTITY });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ success: false, errorClass: 'TypeError', code: 'DESCARGA_FALLIDA' });
    expect(res.body.descargaId).toMatch(/^DESC-/);
    expect(createSessionAndAlert.mock.calls[0][0].devinEmail).toBe(IDENTITY.devinEmail);
  });

  test('POST /api/bccr/descargas succeeds for an older publication', async () => {
    const res = await request('POST', '/api/bccr/descargas', { publicacionId: OLDER.id });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe(OLDER.link);
  });

  test('POST /api/bccr/descargas rejects an unknown publication with 400', async () => {
    const res = await request('POST', '/api/bccr/descargas', { publicacionId: 'no-existe' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PUBLICACION_INVALIDA');
  });
});
