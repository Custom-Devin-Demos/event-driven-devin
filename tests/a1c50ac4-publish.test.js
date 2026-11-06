/* global describe, expect, test, jest, afterEach, setImmediate */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const routes = require('../app/routes/verticals/a1c50ac4');
const { publishStory, deskForSite, DESK_REGISTRY, QUEUE } = require('../app/services/verticals/a1c50ac4');

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
const storyFor = (desk) => QUEUE.find((s) => s.desk === desk);

describe('a1c50ac4 newsroom desk publishing', () => {
  afterEach(() => {
    delete DESK_REGISTRY.barrons;
    createSessionAndAlert.mockClear();
  });

  test('lists the desk queue across all three desks', async () => {
    const res = await request('GET', '/api/a1c50ac4/queue');
    expect(res.status).toBe(200);
    expect(new Set(res.body.stories.map((s) => s.desk))).toEqual(new Set(['wsj', 'barrons', 'marketwatch']));
  });

  test.each(['wsj', 'marketwatch'])('%s stories publish without alerting', async (desk) => {
    const res = await request('POST', '/api/a1c50ac4/publish', { articleId: storyFor(desk).id });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('publish');
    await tick();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('unknown article returns 404 and does not alert', async () => {
    const res = await request('POST', '/api/a1c50ac4/publish', { articleId: 1 });
    expect(res.status).toBe(404);
    await tick();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test("Barron's publish fails with the PHP TypeError and points Devin at the newsroom repo", async () => {
    const res = await request('POST', '/api/a1c50ac4/publish', { articleId: storyFor('barrons').id, devinEmail: 'presenter@example.com' });
    expect(res.status).toBe(500);
    expect(res.body.errorClass).toBe('TypeError');
    expect(res.body.error).toContain('DeskRegistry::forSite(): Return value must be of type array, null returned');
    await tick();
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('a1c50ac4');
    expect(alert.skipVulnerablePr).toBe(true);
    expect(alert.platform).toBe('php');
    expect(alert.devinEmail).toBe('presenter@example.com');
    expect(alert.promptAppendix).toContain('COG-GTM/dowjones-newsroom-wp');
    expect(alert.promptAppendix).toContain('src/Editorial/DeskRegistry.php');
  });

  test("Barron's publishes once the registry has a /barrons/ entry", async () => {
    DESK_REGISTRY.barrons = DESK_REGISTRY['barrons-online'];
    expect(deskForSite('/barrons/').paywall).toBe('hard');
    const result = publishStory({ articleId: storyFor('barrons').id });
    expect(result.desk).toBe("Barron's");
    await tick();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});
