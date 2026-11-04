/* global describe, expect, test, jest, afterEach, setImmediate */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const routes = require('../app/routes/verticals/7cef5900');
const {
  bookAppointment,
  searchPractitioners,
  PRACTITIONERS,
  DB1,
} = require('../app/services/verticals/7cef5900');

function request(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use(routes);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const payload = body === undefined ? '' : JSON.stringify(body);
      const headers = { 'Content-Length': Buffer.byteLength(payload) };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method, headers }, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => server.close(() => resolve({ status: res.statusCode, body: JSON.parse(raw) })));
      });
      req.on('error', (error) => server.close(() => reject(error)));
      req.end(payload);
    });
  });
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const BOOKING = { practitionerId: 'p-1042', date: '2026-11-05', time: '09:00', motive: 'consultation' };
const INDEX = 'index_appointments_on_practitioner_id_and_starts_at';

describe('7cef5900 patient booking', () => {
  afterEach(() => {
    DB1.indexes[INDEX] = false;
    createSessionAndAlert.mockClear();
  });

  test('lists practitioners with five days of slots', async () => {
    const res = await request('GET', '/api/7cef5900/practitioners');
    expect(res.status).toBe(200);
    expect(res.body.practitioners).toHaveLength(PRACTITIONERS.length);
    res.body.practitioners.forEach((p) => expect(p.days).toHaveLength(5));
    expect(searchPractitioners()[0].days.some((d) => d.times.length > 0)).toBe(true);
    expect(searchPractitioners({ from: new Date(2026, 10, 4, 0, 30) })[0].days[0].date).toBe('2026-11-04');
  });

  test('rejects an invalid booking with 400 and no alert', async () => {
    const res = await request('POST', '/api/7cef5900/appointments', { ...BOOKING, motive: 'unknown' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BOOKING_INVALID');
    await tick();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('booking confirmation fails with 503 and pages on-call while the index is missing', async () => {
    const res = await request('POST', '/api/7cef5900/appointments', BOOKING);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('BOOKING_DB_TIMEOUT');
    expect(res.body.error).toMatch(/indisponible/);
    await tick();
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('7cef5900');
    expect(alert.skipVulnerablePr).toBe(true);
    expect(alert.errorType).toBe('ActiveRecord::QueryCanceled');
    expect(alert.promptAppendix).toContain('COG-GTM/doctolib-grand-public');
    expect(alert.promptAppendix).toContain('20261012141500_consolidate_appointment_indexes');
  });

  test('booking succeeds once the clash check can use an index', async () => {
    DB1.indexes[INDEX] = true;
    const result = await bookAppointment(BOOKING);
    expect(result.success).toBe(true);
    expect(result.appointment.motive).toBe('Consultation de suivi');
    await tick();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});
