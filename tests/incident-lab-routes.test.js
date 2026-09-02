const express = require('express');
const http = require('http');

process.env.INCIDENT_LAB_TOKEN = 'lab-test-token';
process.env.INCIDENT_LAB_STATE_FILE = require('path').join(
  require('os').tmpdir(),
  `incident-lab-routes-test-${process.pid}-${Date.now()}.json`,
);

// The routes module registers the real Datadog/Slack sinks at require time;
// stub them so route tests never emit external traffic and declare() gets
// its incident from a test double.
jest.mock('../app/services/incident-lab/datadog-emitter', () => ({
  createDatadogSink: () => ({
    name: 'datadog-stub',
    onDeclare: (run) => { run.incident = { id: 'inc-test', publicId: 7 }; },
  }),
}));
jest.mock('../app/services/incident-lab/personas', () => ({
  createSlackPersonaSink: () => ({ name: 'personas-stub' }),
}));

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

    const status = await (await request('GET', '/api/incident-lab/status', { token })).json();
    expect(status.status).toBe('declared');
    expect(status.phases).toContain('mitigated');

    const publicStatus = await (await request('GET', '/api/incident-lab/status')).json();
    expect(publicStatus.status).toBe('declared');
    expect(publicStatus.runRef).toBeUndefined();
    expect(publicStatus.incident).toBeUndefined();
    expect(publicStatus.log).toBeUndefined();

    const stopped = await request('POST', '/api/incident-lab/stop', { token });
    expect(stopped.status).toBe(200);
  });

  test('run arms with a pending declaration and requires the lab token', async () => {
    const token = 'lab-test-token';
    expect((await request('POST', '/api/incident-lab/run', {
      body: { scenario: 'flowforge-scheduled-workflows' },
    })).status).toBe(403);

    const started = await request('POST', '/api/incident-lab/run', {
      token,
      body: { scenario: 'flowforge-scheduled-workflows' },
    });
    expect(started.status).toBe(200);

    const status = await (await request('GET', '/api/incident-lab/status', { token })).json();
    expect(status.status).toBe('armed');
    expect(status.declaresInMs).toBeGreaterThan(0);

    expect((await request('POST', '/api/incident-lab/stop', { token })).status).toBe(200);
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

  test('mutations are throttled per window', async () => {
    const token = 'lab-test-token';
    process.env.INCIDENT_LAB_MUTATION_LIMIT = '1';
    process.env.INCIDENT_LAB_MUTATION_WINDOW_MS = '5000';
    try {
      await new Promise((resolve) => setTimeout(resolve, 5100)); // let prior tests' mutations age out
      const first = await request('POST', '/api/incident-lab/stop', { token });
      expect([200, 400]).toContain(first.status);
      const second = await request('POST', '/api/incident-lab/stop', { token });
      expect(second.status).toBe(429);
    } finally {
      delete process.env.INCIDENT_LAB_MUTATION_LIMIT;
      delete process.env.INCIDENT_LAB_MUTATION_WINDOW_MS;
    }
  }, 15000);
});
