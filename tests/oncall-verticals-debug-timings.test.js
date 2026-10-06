const express = require('express');

jest.mock('../app/services/oncall-verticals/banking', () => ({
  ...jest.requireActual('../app/services/oncall-verticals/banking'),
  processTransfer: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../app/services/oncall-verticals/industrials', () => ({
  ...jest.requireActual('../app/services/oncall-verticals/industrials'),
  processQuote: jest.fn(async () => ({ ok: true })),
}));

const { processTransfer } = require('../app/services/oncall-verticals/banking');
const { processQuote } = require('../app/services/oncall-verticals/industrials');
const routes = require('../app/routes/oncall-verticals');

let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(routes);
  server = app.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => { server.close(done); });
beforeEach(() => { processTransfer.mockClear(); processQuote.mockClear(); });

const post = (path, headers = {}) => fetch(`${baseUrl}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: '{}',
});

describe.each([
  ['/api/oncall/banking/transfer', () => processTransfer],
  ['/api/oncall/industrials/quote', () => processQuote],
])('%s x-debug-timings header', (route, service) => {
  test('enables debugTimings when the header is 1', async () => {
    expect((await post(route, { 'x-debug-timings': '1' })).status).toBe(200);
    expect(service().mock.calls[0][1]).toEqual({ debugTimings: true });
  });

  test('leaves debugTimings off without the header', async () => {
    expect((await post(route)).status).toBe(200);
    expect(service().mock.calls[0][1]).toEqual({ debugTimings: false });
  });
});
