const express = require('express');
const http = require('http');

process.env.INCIDENT_LAB_TOKEN = 'lab-test-token';

const incidentLabRoutes = require('../app/routes/incident-lab');
const engine = require('../app/services/incident-lab/engine');

let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(incidentLabRoutes);
  server = http.createServer(app);
  server.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => {
  server.close(done);
});

afterEach(async () => {
  const run = engine.currentRun();
  if (run && run.status !== 'stopped') await engine.stop('test cleanup');
});

function request(method, path, { token, body } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Lab-Token': token } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

describe('incident-lab routes', () => {
  test('serves the presenter page and public status', async () => {
    const page = await request('GET', '/oncall/incident-lab');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Incident Lab');

    const status = await request('GET', '/api/incident-lab/status');
    expect(status.status).toBe(200);
    const body = await status.json();
    expect(body.ok).toBe(true);
    expect(body.scenarios.map((s) => s.id)).toContain('flowforge-scheduled-workflows');
  });

  test('mutations require the lab token', async () => {
    const noToken = await request('POST', '/api/incident-lab/arm', {
      body: { scenario: 'flowforge-scheduled-workflows' },
    });
    expect(noToken.status).toBe(403);

    const badToken = await request('POST', '/api/incident-lab/arm', {
      token: 'wrong',
      body: { scenario: 'flowforge-scheduled-workflows' },
    });
    expect(badToken.status).toBe(403);
  });

  test('arm → declare → phase → stop through the API', async () => {
    const token = 'lab-test-token';
    const armed = await request('POST', '/api/incident-lab/arm', {
      token,
      body: { scenario: 'flowforge-scheduled-workflows' },
    });
    expect(armed.status).toBe(200);

    const declared = await request('POST', '/api/incident-lab/declare', { token });
    expect(declared.status).toBe(200);

    const phase = await request('POST', '/api/incident-lab/phase', {
      token,
      body: { phase: 'mitigated' },
    });
    expect(phase.status).toBe(200);

    const status = await (await request('GET', '/api/incident-lab/status')).json();
    expect(status.status).toBe('declared');
    expect(status.phases).toContain('mitigated');

    const stopped = await request('POST', '/api/incident-lab/stop', { token });
    expect(stopped.status).toBe(200);
  });

  test('rejects invalid scenario and phase values', async () => {
    const token = 'lab-test-token';
    const badScenario = await request('POST', '/api/incident-lab/arm', {
      token,
      body: { scenario: 'nope' },
    });
    expect(badScenario.status).toBe(400);

    await request('POST', '/api/incident-lab/arm', {
      token,
      body: { scenario: 'flowforge-scheduled-workflows' },
    });
    await request('POST', '/api/incident-lab/declare', { token });
    const badPhase = await request('POST', '/api/incident-lab/phase', {
      token,
      body: { phase: 'nope' },
    });
    expect(badPhase.status).toBe(400);
  });
});
