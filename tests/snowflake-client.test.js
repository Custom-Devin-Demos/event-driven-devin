/* global describe, expect, test, jest, beforeEach, afterAll */
const crypto = require('crypto');

jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));
jest.mock('../app/telemetry/logger', () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

let axios = require('axios');

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'demo-pass' });
const ORIGINAL_ENV = { ...process.env };

function loadClient(env) {
  jest.resetModules();
  axios = require('axios');
  Object.assign(process.env, {
    SNOWFLAKE_ACCOUNT: 'MYORG-MYACCT',
    SNOWFLAKE_USER: 'svc_demo',
    SNOWFLAKE_PRIVATE_KEY: PEM,
    SNOWFLAKE_PRIVATE_KEY_FILE_PWD: 'demo-pass',
    SNOWFLAKE_WAREHOUSE: 'DEMO_WH',
  }, env);
  return require('../app/services/snowflake-client');
}

function statementResponse(overrides = {}) {
  return {
    status: 200,
    data: {
      statementHandle: 'qid-1',
      resultSetMetaData: {
        rowType: [{ name: 'SYMBOL' }, { name: 'CLOSE_PRICE' }],
        partitionInfo: [{ rowCount: 2 }],
      },
      data: [['AAPL', '268.50'], ['MSFT', '508.20']],
      ...overrides,
    },
  };
}

beforeEach(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith('SNOWFLAKE_')) delete process.env[key];
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('snowflake-client', () => {
  test('isConfigured requires account, user, private key and warehouse', () => {
    expect(loadClient({ SNOWFLAKE_WAREHOUSE: '' }).isConfigured()).toBe(false);
    expect(loadClient().isConfigured()).toBe(true);
  });

  test('signs a key-pair JWT whose issuer carries the public-key fingerprint', () => {
    const client = loadClient();
    const [header, payload, signature] = client.buildJwt().split('.');
    const decode = (part) => JSON.parse(Buffer.from(part, 'base64').toString());
    expect(decode(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = decode(payload);
    expect(claims.sub).toBe('MYORG-MYACCT.SVC_DEMO');
    expect(claims.iss).toMatch(/^MYORG-MYACCT\.SVC_DEMO\.SHA256:[A-Za-z0-9+/=]+$/);
    expect(claims.exp - claims.iat).toBe(50 * 60);
    const publicKey = crypto.createPublicKey({ key: PEM, passphrase: 'demo-pass' });
    const sig = Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    expect(crypto.verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, sig)).toBe(true);
    expect(client.baseUrl()).toBe('https://myorg-myacct.snowflakecomputing.com');
  });

  test('posts the statement with bindings and parameters and maps rows by column name', async () => {
    const client = loadClient();
    axios.post.mockResolvedValue(statementResponse());
    const result = await client.executeStatement('SELECT 1', {
      bindings: { 1: { type: 'TEXT', value: 'x' } }, database: 'DB', schema: 'S', parameters: { USE_CACHED_RESULT: 'false' },
    });
    expect(result.rows).toEqual([{ SYMBOL: 'AAPL', CLOSE_PRICE: '268.50' }, { SYMBOL: 'MSFT', CLOSE_PRICE: '508.20' }]);
    expect(result.queryId).toBe('qid-1');
    const [url, body, options] = axios.post.mock.calls[0];
    expect(url).toBe('https://myorg-myacct.snowflakecomputing.com/api/v2/statements');
    expect(body).toMatchObject({
      statement: 'SELECT 1', database: 'DB', schema: 'S', warehouse: 'DEMO_WH', bindings: { 1: { type: 'TEXT', value: 'x' } }, parameters: { MULTI_STATEMENT_COUNT: '1', USE_CACHED_RESULT: 'false' },
    });
    expect(options.headers.Authorization).toMatch(/^Bearer /);
    expect(options.headers['X-Snowflake-Authorization-Token-Type']).toBe('KEYPAIR_JWT');
  });

  test('pages through additional result partitions', async () => {
    const client = loadClient();
    axios.post.mockResolvedValue(statementResponse({
      resultSetMetaData: { rowType: [{ name: 'SYMBOL' }, { name: 'CLOSE_PRICE' }], partitionInfo: [{ rowCount: 2 }, { rowCount: 1 }] },
    }));
    axios.get.mockResolvedValue({ status: 200, data: { data: [['NVDA', '186.40']] } });
    const result = await client.executeStatement('SELECT 1');
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(axios.get.mock.calls[0][0]).toBe('https://myorg-myacct.snowflakecomputing.com/api/v2/statements/qid-1');
    expect(axios.get.mock.calls[0][1].params).toEqual({ partition: 1 });
    expect(result.rows.map((r) => r.SYMBOL)).toEqual(['AAPL', 'MSFT', 'NVDA']);
  });

  test('surfaces Snowflake errors and still-running statements as typed errors', async () => {
    const client = loadClient();
    axios.post.mockResolvedValueOnce({ status: 422, data: { message: 'SQL compilation error', code: '001003', sqlState: '42000' } });
    await expect(client.executeStatement('SELEC 1')).rejects.toMatchObject({ name: 'SnowflakeStatementError', code: '001003', sqlState: '42000' });
    axios.post.mockResolvedValueOnce({ status: 202, data: { statementHandle: 'qid-slow' } });
    await expect(client.executeStatement('SELECT 1', { timeoutSeconds: 5 })).rejects.toMatchObject({ name: 'SnowflakeStatementTimeout', statementHandle: 'qid-slow' });
  });
});
