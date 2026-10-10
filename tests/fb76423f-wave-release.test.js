/* global afterAll, beforeAll, beforeEach, describe, expect, jest, test */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
}));

const express = require('express');
const http = require('http');
const { createSessionAndAlert } = require('../app/services/devin-session');
const verticalRoutes = require('../app/routes/verticals');

let server;
let baseUrl;

function request(method, path, body) {
  const payload = body === undefined ? '' : JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const responseBody = res.headers['content-type']?.includes('application/json')
          ? JSON.parse(data)
          : data;
        resolve({ status: res.statusCode, body: responseBody });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(verticalRoutes);
  server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => {
  server.close(done);
});

beforeEach(() => {
  createSessionAndAlert.mockClear();
});

describe('Dollar General DC wave release (fb76423f)', () => {
  test('returns the DC 41 board with all three waves', async () => {
    const res = await request('GET', '/api/fb76423f/board');

    expect(res.status).toBe(200);
    expect(res.body.dc.id).toBe('DC 41');
    expect(res.body.waves.map(({ waveId }) => waveId)).toEqual([
      'W41-1009-03',
      'W41-1009-04',
      'W41-1009-05',
    ]);
  });

  test('previews the paper towels at location A-14-03-B', async () => {
    const res = await request('POST', '/api/fb76423f/waves/W41-1009-03/preview');

    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ sku: '21447803', location: 'A-14-03-B' }),
    ]));
  });

  test.each([
    ['W41-1009-04', 40, 190],
    ['W41-1009-05', 24, 128],
  ])('releases wave %s', async (waveId, pickTasks, casesReleased) => {
    const res = await request('POST', `/api/fb76423f/waves/${waveId}/release`, { confirmed: true });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      pickTasks,
      casesReleased,
      shorts: [],
    });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('requires confirmation before releasing a wave', async () => {
    const res = await request('POST', '/api/fb76423f/waves/W41-1009-04/release', {});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_CONFIRMED');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('returns an unknown-wave error for an unrecognized wave ID', async () => {
    const res = await request('POST', '/api/fb76423f/waves/W41-9999-99/release', { confirmed: true });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('UNKNOWN_WAVE');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('serves the Dollar General DC page', async () => {
    const res = await request('GET', '/dollar-general-dc');

    expect(res.status).toBe(200);
    expect(res.body).toContain('Wave Release');
  });
});
