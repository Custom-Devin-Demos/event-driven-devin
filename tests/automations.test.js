/* global afterEach, beforeEach, describe, expect, jest, test */

const express = require('express');
const http = require('http');

jest.mock('../app/services/devin-api', () => ({
  createDevinSession: jest.fn(),
}));

const ENVIRONMENT_KEYS = [
  'AUTOMATIONS_RUN_TOKEN',
  'AUTOMATIONS_RUN_MAX_PER_HOUR',
  'AUTOMATIONS_RUN_ATTACH_WINDOW_MINUTES',
  'SESSION_CAP_GLOBAL_MAX',
  'SESSION_CAP_WINDOW_MINUTES',
];

function restoreEnvironmentVariable(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function request(path, router, options = {}) {
  const app = express();
  app.use(router);
  if (options.errorHandler) {
    app.use(options.errorHandler);
  }

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const requestOptions = {
        hostname: '127.0.0.1',
        port,
        path,
        method: options.method || 'GET',
        headers: options.headers || {},
      };
      const clientRequest = http.request(requestOptions, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          server.close();
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString(),
          });
        });
      });
      clientRequest.on('error', (error) => {
        server.close();
        reject(error);
      });
      clientRequest.end();
    });
  });
}

describe('automations page and Run Now endpoint', () => {
  let originalEnvironment;

  beforeEach(() => {
    originalEnvironment = Object.fromEntries(
      ENVIRONMENT_KEYS.map((name) => [name, process.env[name]]),
    );
    jest.resetModules();
    jest.clearAllMocks();
  });

  afterEach(() => {
    for (const name of ENVIRONMENT_KEYS) {
      restoreEnvironmentVariable(name, originalEnvironment[name]);
    }
  });

  function loadRouter(overrides = {}) {
    Object.assign(process.env, {
      AUTOMATIONS_RUN_TOKEN: 'presenter-token',
      AUTOMATIONS_RUN_MAX_PER_HOUR: '3',
      AUTOMATIONS_RUN_ATTACH_WINDOW_MINUTES: '15',
      SESSION_CAP_GLOBAL_MAX: '30',
      SESSION_CAP_WINDOW_MINUTES: '10',
      ...overrides,
    });
    return require('../app/routes/automations');
  }

  function createSessionMock() {
    return require('../app/services/devin-api').createDevinSession;
  }

  test('returns 503 and never spawns when the presenter token is not configured', async () => {
    const router = loadRouter({ AUTOMATIONS_RUN_TOKEN: '' });
    const createDevinSession = createSessionMock();
    const response = await request('/api/automations/run', router, {
      method: 'POST',
    });

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ success: false, reason: 'not_configured' });
    expect(createDevinSession).not.toHaveBeenCalled();
  });

  test.each([
    ['absent', {}],
    ['wrong', { headers: { 'x-automations-token': 'wrong-token' } }],
  ])('returns 403 for an %s presenter token', async (_label, options) => {
    const router = loadRouter();
    const response = await request('/api/automations/run', router, {
      method: 'POST',
      ...options,
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ success: false, reason: 'forbidden' });
  });

  test('rejects a wrong multi-byte token without invoking the error handler', async () => {
    const router = loadRouter({ AUTOMATIONS_RUN_TOKEN: 'abcde' });
    const errors = [];
    const response = await request('/api/automations/run', router, {
      method: 'POST',
      headers: { 'x-automations-token': 'éabcd' },
      errorHandler: (error, _req, _res, _next) => errors.push(error),
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ success: false, reason: 'forbidden' });
    expect(errors).toHaveLength(0);
  });

  test('rejects query-string tokens', async () => {
    const router = loadRouter();
    const response = await request('/api/automations/run?token=presenter-token', router, {
      method: 'POST',
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ success: false, reason: 'forbidden' });
  });

  test('spawns a session and attaches a second request within the window', async () => {
    const router = loadRouter();
    const createDevinSession = createSessionMock();
    createDevinSession.mockResolvedValue({ sessionId: 'session-1', url: 'https://app.devin.ai/sessions/session-1' });

    const first = await request('/api/automations/run', router, {
      method: 'POST',
      headers: { 'x-automations-token': 'presenter-token' },
    });
    const second = await request('/api/automations/run', router, {
      method: 'POST',
      headers: { 'x-automations-token': 'presenter-token' },
    });

    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.body)).toEqual(expect.objectContaining({
      success: true,
      sessionId: 'session-1',
      url: 'https://app.devin.ai/sessions/session-1',
      attached: false,
    }));
    expect(JSON.parse(second.body)).toEqual(expect.objectContaining({
      success: true,
      sessionId: 'session-1',
      attached: true,
    }));
    expect(createDevinSession).toHaveBeenCalledTimes(1);
  });

  test('single-flights concurrent patrol spawns', async () => {
    const router = loadRouter();
    const createDevinSession = createSessionMock();
    let resolveSpawn;
    createDevinSession.mockReturnValue(new Promise((resolve) => {
      resolveSpawn = resolve;
    }));

    const requests = [
      request('/api/automations/run', router, {
        method: 'POST',
        headers: { 'x-automations-token': 'presenter-token' },
      }),
      request('/api/automations/run', router, {
        method: 'POST',
        headers: { 'x-automations-token': 'presenter-token' },
      }),
    ];
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(createDevinSession).toHaveBeenCalledTimes(1);

    resolveSpawn({ sessionId: 'session-1', url: 'https://app.devin.ai/sessions/session-1' });
    const responses = await Promise.all(requests);

    expect(responses[0].statusCode).toBe(200);
    expect(responses[1].statusCode).toBe(200);
    expect(JSON.parse(responses[0].body)).toEqual(expect.objectContaining({
      sessionId: 'session-1',
      attached: false,
    }));
    expect(JSON.parse(responses[1].body)).toEqual(expect.objectContaining({
      sessionId: 'session-1',
      attached: true,
    }));
  });

  test('returns 429 with Retry-After when the patrol cap is exceeded', async () => {
    const router = loadRouter({
      AUTOMATIONS_RUN_MAX_PER_HOUR: '1',
      AUTOMATIONS_RUN_ATTACH_WINDOW_MINUTES: '0',
    });
    const createDevinSession = createSessionMock();
    createDevinSession.mockResolvedValue({ sessionId: 'session-1', url: 'https://app.devin.ai/sessions/session-1' });

    await request('/api/automations/run', router, {
      method: 'POST',
      headers: { 'x-automations-token': 'presenter-token' },
    });
    const response = await request('/api/automations/run', router, {
      method: 'POST',
      headers: { 'x-automations-token': 'presenter-token' },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBeDefined();
    expect(JSON.parse(response.body)).toEqual(expect.objectContaining({
      success: false,
      reason: 'throttled',
    }));
  });

  test('explicit zero patrol cap blocks every run', async () => {
    const router = loadRouter({ AUTOMATIONS_RUN_MAX_PER_HOUR: '0' });
    const response = await request('/api/automations/run', router, {
      method: 'POST',
      headers: { 'x-automations-token': 'presenter-token' },
    });

    expect(response.statusCode).toBe(429);
    expect(JSON.parse(response.body).reason).toBe('throttled');
  });

  test('throttles repeated failed-token attempts', async () => {
    const router = loadRouter();
    let response;
    for (let attempt = 0; attempt < 11; attempt += 1) {
      response = await request('/api/automations/run', router, {
        method: 'POST',
        headers: { 'x-automations-token': 'wrong-token' },
      });
    }

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBeDefined();
    expect(JSON.parse(response.body)).toEqual(expect.objectContaining({
      success: false,
      reason: 'throttled',
    }));
  });

  test('releases the global reservation after session creation fails', async () => {
    const router = loadRouter({
      AUTOMATIONS_RUN_ATTACH_WINDOW_MINUTES: '0',
      SESSION_CAP_GLOBAL_MAX: '1',
    });
    const createDevinSession = createSessionMock();
    createDevinSession
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ sessionId: 'session-2', url: 'https://app.devin.ai/sessions/session-2' });
    const errors = [];
    const errorHandler = (error, _req, _res, _next) => errors.push(error);

    const failed = await request('/api/automations/run', router, {
      method: 'POST',
      headers: { 'x-automations-token': 'presenter-token' },
      errorHandler,
    });
    const retried = await request('/api/automations/run', router, {
      method: 'POST',
      headers: { 'x-automations-token': 'presenter-token' },
      errorHandler,
    });

    expect(failed.statusCode).toBe(500);
    expect(JSON.parse(failed.body)).toEqual({ success: false, reason: 'spawn_failed' });
    expect(retried.statusCode).toBe(200);
    expect(JSON.parse(retried.body).sessionId).toBe('session-2');
    expect(errors).toHaveLength(0);
  });

  test('serves the noindex automations page', async () => {
    const router = loadRouter();
    const response = await request('/automations', router);

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<meta name="robots" content="noindex,nofollow">');
  });
});
