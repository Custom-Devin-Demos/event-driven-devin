jest.mock('uuid', () => ({ v4: () => 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE' }));
jest.mock('../../telemetry/logger', () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }));
jest.mock('../../telemetry/datadog', () => ({ incrementMetric: jest.fn(), recordTiming: jest.fn() }));
jest.mock('../../telemetry/sentry', () => ({ Sentry: { captureException: jest.fn(), setContext: jest.fn(), setTag: jest.fn(), setExtra: jest.fn(), withScope: jest.fn((cb) => cb({ setTag: jest.fn(), setExtra: jest.fn(), setLevel: jest.fn() })) } }));
jest.mock('../../services/devin-session', () => ({ createSessionAndAlert: jest.fn().mockResolvedValue({}) }));

const express = require('express');
const router = require('./e0c16510');

let app;
let server;

beforeAll((done) => {
  app = express();
  app.use(express.json());
  app.use(router);
  server = app.listen(0, done);
});

afterAll((done) => {
  server.close(done);
});

function postContactSales(body) {
  const port = server.address().port;
  return fetch(`http://localhost:${port}/api/e0c16510/contact-sales`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/e0c16510/contact-sales', () => {
  test('succeeds with capitalized plan ID "Enterprise"', async () => {
    const res = await postContactSales({
      firstName: 'Taro',
      lastName: 'Yamada',
      email: 'taro@example.com',
      company: 'TestCo',
      plan: 'Enterprise',
      seats: 10,
      region: 'ap-northeast-1',
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.plan.name).toBe('エンタープライズ');
    expect(data.plan.seats).toBe(10);
  });

  test('succeeds with lowercase plan ID "enterprise"', async () => {
    const res = await postContactSales({
      firstName: 'Hanako',
      lastName: 'Sato',
      email: 'hanako@example.com',
      company: 'AcmeCo',
      plan: 'enterprise',
      seats: 25,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.plan.name).toBe('エンタープライズ');
  });

  test('succeeds with mixed-case plan ID "PROFESSIONAL"', async () => {
    const res = await postContactSales({
      firstName: 'John',
      lastName: 'Doe',
      email: 'john@example.com',
      company: 'Corp',
      plan: 'PROFESSIONAL',
      seats: 5,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.plan.name).toBe('プロフェッショナル');
  });

  test('succeeds with plan ID with leading/trailing whitespace', async () => {
    const res = await postContactSales({
      firstName: 'Test',
      lastName: 'User',
      email: 'test@example.com',
      company: 'Corp',
      plan: '  starter  ',
      seats: 3,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.plan.name).toBe('スターター');
  });

  test('returns error for truly invalid plan ID', async () => {
    const res = await postContactSales({
      firstName: 'Bad',
      lastName: 'Plan',
      email: 'bad@example.com',
      company: 'Corp',
      plan: 'nonexistent',
      seats: 1,
    });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toContain('nonexistent');
  });

  test('defaults to enterprise plan when no plan specified', async () => {
    const res = await postContactSales({
      firstName: 'Default',
      lastName: 'Plan',
      email: 'default@example.com',
      company: 'Corp',
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.plan.name).toBe('エンタープライズ');
  });
});
