const crypto = require('crypto');
const axios = require('axios');
const logger = require('../telemetry/logger');

/**
 * Minimal Snowflake SQL REST API client (POST /api/v2/statements) using
 * key-pair JWT authentication. Zero native dependencies: the JWT is signed
 * with Node's crypto module, so the demo host does not need snowflake-sdk.
 *
 * Configuration (all optional; `isConfigured()` is false when any is missing):
 *   SNOWFLAKE_ACCOUNT               org-account identifier, e.g. MYORG-MYACCT
 *   SNOWFLAKE_USER                  service user with key-pair auth
 *   SNOWFLAKE_PRIVATE_KEY           PEM (PKCS#8, optionally encrypted)
 *   SNOWFLAKE_PRIVATE_KEY_FILE_PWD  passphrase for an encrypted PEM
 *   SNOWFLAKE_WAREHOUSE             warehouse to run statements on
 *   SNOWFLAKE_ROLE                  optional role override
 */

const TOKEN_TTL_SECONDS = 50 * 60;
let cachedToken = null;

function config() {
  return {
    account: (process.env.SNOWFLAKE_ACCOUNT || '').trim(),
    user: (process.env.SNOWFLAKE_USER || '').trim(),
    privateKey: process.env.SNOWFLAKE_PRIVATE_KEY || '',
    passphrase: process.env.SNOWFLAKE_PRIVATE_KEY_FILE_PWD || undefined,
    warehouse: (process.env.SNOWFLAKE_WAREHOUSE || '').trim(),
    role: (process.env.SNOWFLAKE_ROLE || '').trim() || undefined,
  };
}

function isConfigured() {
  const c = config();
  return Boolean(c.account && c.user && c.privateKey && c.warehouse);
}

function baseUrl() {
  return `https://${config().account.toLowerCase()}.snowflakecomputing.com`;
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function buildJwt() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt - 120 > now) return cachedToken.token;

  const c = config();
  const privateKey = crypto.createPrivateKey({ key: c.privateKey.replace(/\\n/g, '\n'), format: 'pem', passphrase: c.passphrase });
  const publicDer = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const fingerprint = crypto.createHash('sha256').update(publicDer).digest('base64');
  const qualifiedUser = `${c.account.toUpperCase()}.${c.user.toUpperCase()}`;

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: `${qualifiedUser}.SHA256:${fingerprint}`,
    sub: qualifiedUser,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  }));
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey);
  const token = `${header}.${payload}.${base64url(signature)}`;
  cachedToken = { token, expiresAt: now + TOKEN_TTL_SECONDS };
  return token;
}

function rowsFromResult(result) {
  const columns = ((result.resultSetMetaData || {}).rowType || []).map((col) => col.name);
  return (result.data || []).map((row) => Object.fromEntries(row.map((value, i) => [columns[i], value])));
}

/**
 * Execute one SQL statement and return `{ rows, queryId, durationMs, statementHandle }`.
 * `bindings` follows the REST API shape: `{ '1': { type: 'TEXT', value: 'x' } }`;
 * `parameters` are session parameters for the statement, e.g. `{ USE_CACHED_RESULT: 'false' }`.
 */
async function executeStatement(statement, {
  bindings, database, schema, timeoutSeconds = 60, role, warehouse, parameters = {},
} = {}) {
  const c = config();
  const startedAt = Date.now();
  const response = await axios.post(`${baseUrl()}/api/v2/statements`, {
    statement,
    timeout: timeoutSeconds,
    database,
    schema,
    warehouse: warehouse || c.warehouse,
    role: role || c.role,
    bindings,
    parameters: { MULTI_STATEMENT_COUNT: '1', ...parameters },
  }, {
    params: { async: 'false' },
    headers: {
      Authorization: `Bearer ${buildJwt()}`,
      'X-Snowflake-Authorization-Token-Type': 'KEYPAIR_JWT',
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'event-driven-devin/1.0',
    },
    timeout: (timeoutSeconds + 15) * 1000,
    validateStatus: () => true,
  });

  const body = response.data || {};
  if (response.status >= 400) {
    const error = new Error(`Snowflake statement failed (${response.status}): ${body.message || response.statusText}`);
    error.name = 'SnowflakeStatementError';
    error.code = body.code;
    error.sqlState = body.sqlState;
    error.statementHandle = body.statementHandle;
    throw error;
  }
  if (response.status === 202) {
    const error = new Error(`Snowflake statement ${body.statementHandle} still running after ${timeoutSeconds}s`);
    error.name = 'SnowflakeStatementTimeout';
    error.statementHandle = body.statementHandle;
    throw error;
  }

  let rows = rowsFromResult(body);
  // Page through large result sets (partitions beyond the first).
  const partitions = ((body.resultSetMetaData || {}).partitionInfo || []).length;
  for (let partition = 1; partition < partitions; partition += 1) {
    const page = await axios.get(`${baseUrl()}/api/v2/statements/${body.statementHandle}`, {
      params: { partition },
      headers: { Authorization: `Bearer ${buildJwt()}`, 'X-Snowflake-Authorization-Token-Type': 'KEYPAIR_JWT', Accept: 'application/json' },
      timeout: 60000,
    });
    rows = rows.concat(rowsFromResult({ ...page.data, resultSetMetaData: body.resultSetMetaData }));
  }

  const durationMs = Date.now() - startedAt;
  logger.debug('Snowflake statement completed', { statementHandle: body.statementHandle, rowCount: rows.length, durationMs });
  return { rows, queryId: body.statementHandle, statementHandle: body.statementHandle, durationMs };
}

module.exports = { isConfigured, executeStatement, buildJwt, baseUrl };
