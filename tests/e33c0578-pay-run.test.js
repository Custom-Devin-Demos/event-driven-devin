/* global describe, expect, test, jest, afterEach */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const payRunRoutes = require('../app/routes/verticals/e33c0578');
const {
  submitPayRun,
  calculateGrossPay,
  resolveWorkRule,
  EMPLOYEES,
  WORK_RULES,
  PAY_GROUP,
} = require('../app/services/verticals/e33c0578');

const ALL_EMPLOYEE_IDS = EMPLOYEES.map((employee) => employee.id);
const REGISTERED_EMPLOYEE_IDS = EMPLOYEES
  .filter((employee) => WORK_RULES[employee.workRule])
  .map((employee) => employee.id);

const WEEKEND_ROTATION_RULE = {
  label: 'Weekend rotation (Northgate)',
  overtimeMultiplier: 1.5,
  doubleTimeMultiplier: 2,
  overtimeThresholdHours: 40,
  shiftDifferential: 1.75,
};

function postPayRun(body) {
  const app = express();
  app.use(express.json());
  app.use(payRunRoutes);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const payload = body === undefined ? '' : JSON.stringify(body);
      const headers = { 'Content-Length': Buffer.byteLength(payload) };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/e33c0578/pay-run',
          method: 'POST',
          headers,
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

const VALID_REQUEST = {
  payGroupId: PAY_GROUP.id,
  employeeIds: ALL_EMPLOYEE_IDS,
  devinUserId: 'clerk-user_demo',
  devinOrgId: 'org_demo',
  devinEmail: 'payroll.ops@riverbendhealth.example',
};

afterEach(() => {
  delete WORK_RULES['US-WEEKEND-ROTATION'];
  createSessionAndAlert.mockClear();
});

describe('UKG Pro pay run calculation', () => {
  test('calculates gross pay for an hourly employee on a registered work rule', () => {
    const line = calculateGrossPay(EMPLOYEES.find((employee) => employee.id === 'E-100341'));

    expect(line.workRule).toBe('Healthcare 8/80 (8h day, 80h period)');
    expect(line.regularPay).toBe(3880);
    expect(line.premiumPay).toBe(616.5);
    expect(line.grossPay).toBe(4496.5);
  });

  test('calculates gross pay for a salaried exempt employee', () => {
    const line = calculateGrossPay(EMPLOYEES.find((employee) => employee.id === 'E-100412'));

    expect(line.grossPay).toBe(6250);
    expect(line.premiumPay).toBe(0);
  });

  test('submits a pay run containing only registered work rules', async () => {
    const result = await submitPayRun({ ...VALID_REQUEST, employeeIds: REGISTERED_EMPLOYEE_IDS });

    expect(result.success).toBe(true);
    expect(result.confirmation).toMatch(/^PR-[0-9A-F]{8}$/);
    expect(result.status).toBe('submitted_to_treasury');
    expect(result.employeeCount).toBe(REGISTERED_EMPLOYEE_IDS.length);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});

describe('UKG Pro pay run unregistered work rule', () => {
  test('has no payroll work rule for the Northgate weekend rotation', () => {
    expect(resolveWorkRule({ workRule: 'US-WEEKEND-ROTATION' })).toBeUndefined();
  });

  test('raises a TypeError and sends the Cognition identity to the alert flow', async () => {
    await expect(submitPayRun(VALID_REQUEST)).rejects.toThrow(TypeError);

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('e33c0578');
    expect(alert.service).toBe('customer-e33c0578-pay-run');
    expect(alert.culprit).toBe('app/services/verticals/e33c0578.js — calculateGrossPay');
    expect(alert.errorType).toBe('TypeError');
    expect(alert.devinUserId).toBe('clerk-user_demo');
    expect(alert.devinOrgId).toBe('org_demo');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/e33c0578/pay-run' },
      { key: 'payGroup', value: PAY_GROUP.id },
    ]));
  });

  test('returns a 500 response for the default pay run', async () => {
    const { status, body } = await postPayRun(VALID_REQUEST);

    expect(status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.errorClass).toBe('TypeError');
    expect(body.error).toMatch(/Cannot read properties of undefined \(reading 'shiftDifferential'\)/);
    expect(body.code).toBe('PAY_RUN_SUBMISSION_FAILED');
  });
});

describe('UKG Pro pay run fixed behavior', () => {
  test('submits every employee once the weekend rotation rule is registered', async () => {
    WORK_RULES['US-WEEKEND-ROTATION'] = { ...WEEKEND_ROTATION_RULE };

    const result = await submitPayRun(VALID_REQUEST);

    expect(result.success).toBe(true);
    expect(result.employeeCount).toBe(EMPLOYEES.length);
    expect(result.lines.find((line) => line.employeeId === 'E-100503').grossPay).toBe(2952.9);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('returns 200 from the API once the weekend rotation rule is registered', async () => {
    WORK_RULES['US-WEEKEND-ROTATION'] = { ...WEEKEND_ROTATION_RULE };

    const { status, body } = await postPayRun(VALID_REQUEST);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.payDate).toBe(PAY_GROUP.payDate);
  });
});

describe('UKG Pro pay run validation', () => {
  test('rejects an unknown pay group without creating an alert', async () => {
    const { status, body } = await postPayRun({ ...VALID_REQUEST, payGroupId: 'PG-UNKNOWN' });

    expect(status).toBe(400);
    expect(body.errorClass).toBe('ValidationError');
    expect(body.code).toBe('PAY_GROUP_INVALID');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('rejects a pay run with no employees selected', async () => {
    const { status, body } = await postPayRun({ ...VALID_REQUEST, employeeIds: [] });

    expect(status).toBe(400);
    expect(body.code).toBe('NO_EMPLOYEES_SELECTED');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('rejects a request with no JSON body as a validation error', async () => {
    const { status, body } = await postPayRun(undefined);

    expect(status).toBe(400);
    expect(body.code).toBe('PAY_GROUP_INVALID');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});
