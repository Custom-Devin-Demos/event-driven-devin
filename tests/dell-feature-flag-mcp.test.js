/* global afterAll, beforeAll, beforeEach, describe, expect, test, fetch */

const express = require('express');
const http = require('http');

const dellFeatureFlagMcpRoutes = require('../app/routes/dell-feature-flag-mcp');

const { LANE_SCHEMA_FLAG } = dellFeatureFlagMcpRoutes;

let server;
let url;

const rpc = (body) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
  body: JSON.stringify(body),
});

const callTool = async (id, name, args = {}) => {
  const body = await (await rpc({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })).json();
  return { isError: body.result.isError, payload: JSON.parse(body.result.content[0].text) };
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(dellFeatureFlagMcpRoutes);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  url = `http://127.0.0.1:${server.address().port}${dellFeatureFlagMcpRoutes.MCP_PATH}`;
});

beforeEach(() => dellFeatureFlagMcpRoutes.resetFlags());

afterAll(() => new Promise((resolve) => server.close(resolve)));

describe('Dell feature flag demo MCP', () => {
  test('initialize negotiates the protocol and names the server dell-feature-flag', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'jest', version: '0' } } });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.result.protocolVersion).toBe('2025-03-26');
    expect(body.result.serverInfo.name).toBe('dell-feature-flag');
    expect(body.result.capabilities.tools).toBeDefined();
  });

  test('notifications are accepted without a body and other verbs are refused', async () => {
    const res = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(202);
    const get = await fetch(url);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
  });

  test('read tools are annotated read-only and write tools are not', async () => {
    const body = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
    const byName = Object.fromEntries(body.result.tools.map((tool) => [tool.name, tool]));
    expect(Object.keys(byName)).toEqual(['list_flags', 'get_flag', 'set_flag', 'disable_flag']);
    expect(byName.list_flags.annotations.readOnlyHint).toBe(true);
    expect(byName.get_flag.annotations.readOnlyHint).toBe(true);
    expect(byName.set_flag.annotations.readOnlyHint).toBe(false);
    expect(byName.disable_flag.annotations.readOnlyHint).toBe(false);
    expect(byName.set_flag.inputSchema.required).toEqual(['flagKey', 'enabled', 'reason']);
    expect(byName.disable_flag.inputSchema.required).toEqual(['flagKey', 'reason']);
    body.result.tools.forEach((tool) => expect(tool.description).not.toMatch(/stand-in|synthetic|fake/i));
  });

  test('list_flags shows the lane-schema v2 flag enabled in prod for the storefront service', async () => {
    const { payload } = await callTool(3, 'list_flags', { service: 'customer-683629b3-web' });
    expect(payload.environment).toBe('prod');
    const lane = payload.flags.find((flag) => flag.key === LANE_SCHEMA_FLAG);
    expect(lane).toMatchObject({ enabled: true, rolloutPercent: 100, service: 'customer-683629b3-web' });
    expect(lane.changedBy).toMatch(/acme-checkout@1\.0\.2/);
  });

  test('get_flag returns the change history and the previous state', async () => {
    const { isError, payload } = await callTool(4, 'get_flag', { flagKey: LANE_SCHEMA_FLAG });
    expect(isError).toBe(false);
    expect(payload.environments.prod.previous).toEqual({ enabled: false, rolloutPercent: 0 });
    expect(payload.history[0]).toMatchObject({ environment: 'prod', to: { enabled: true } });

    const unknownTool = await (await rpc({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'rollback_flag', arguments: { flagKey: LANE_SCHEMA_FLAG, reason: 'x' } } })).json();
    expect(unknownTool.error || unknownTool.result.isError).toBeTruthy();

    const unknown = await callTool(5, 'get_flag', { flagKey: 'nope' });
    expect(unknown.isError).toBe(true);
    expect(unknown.payload.error).toMatch(/not found/);
  });

  test('set_flag needs a reason and re-enables a disabled flag', async () => {
    const missing = await (await rpc({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'set_flag', arguments: { flagKey: LANE_SCHEMA_FLAG, enabled: false } } })).json();
    expect(missing.result.isError).toBe(true);
    expect(missing.result.content[0].text).toMatch(/reason/);

    await callTool(9, 'disable_flag', { flagKey: LANE_SCHEMA_FLAG, reason: 'incident' });
    const { payload } = await callTool(10, 'set_flag', { flagKey: LANE_SCHEMA_FLAG, enabled: true, reason: 'fix PR deployed' });
    expect(payload.flag).toMatchObject({ enabled: true, rolloutPercent: 100 });

    const staging = await callTool(11, 'set_flag', { flagKey: LANE_SCHEMA_FLAG, enabled: false, environment: 'qa', reason: 'x' });
    expect(staging.isError).toBe(true);
  });

  test('disable_flag turns the lane-schema flag off, needs a reason, and is a no-op when already off', async () => {
    const missing = await (await rpc({ jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'disable_flag', arguments: { flagKey: LANE_SCHEMA_FLAG } } })).json();
    expect(missing.result.isError).toBe(true);
    expect(missing.result.content[0].text).toMatch(/reason/);

    const { isError, payload } = await callTool(15, 'disable_flag', { flagKey: LANE_SCHEMA_FLAG, reason: 'Sentry NODE-EXPRESS-EX: kill switch while the lane fix ships' });
    expect(isError).toBe(false);
    expect(payload.status).toBe('applied');
    expect(payload.change.from).toEqual({ enabled: true, rolloutPercent: 100 });
    expect(payload.change.to).toEqual({ enabled: false, rolloutPercent: 0 });
    expect(payload.flag).toMatchObject({ key: LANE_SCHEMA_FLAG, environment: 'prod', enabled: false, rolloutPercent: 0 });

    const again = await callTool(16, 'disable_flag', { flagKey: LANE_SCHEMA_FLAG, reason: 'repeat' });
    expect(again.payload.status).toBe('unchanged');
    const after = await callTool(17, 'get_flag', { flagKey: LANE_SCHEMA_FLAG });
    expect(after.payload.history).toHaveLength(3);
    expect(after.payload.environments.prod.enabled).toBe(false);

    const unknown = await callTool(18, 'disable_flag', { flagKey: 'nope', reason: 'x' });
    expect(unknown.isError).toBe(true);
    const badEnv = await callTool(19, 'disable_flag', { flagKey: LANE_SCHEMA_FLAG, environment: 'qa', reason: 'x' });
    expect(badEnv.isError).toBe(true);
  });

  test('flag state is in-process only: reset restores the seeded state', async () => {
    await callTool(12, 'disable_flag', { flagKey: LANE_SCHEMA_FLAG, reason: 'incident' });
    dellFeatureFlagMcpRoutes.resetFlags();
    const { payload } = await callTool(13, 'get_flag', { flagKey: LANE_SCHEMA_FLAG });
    expect(payload.environments.prod.enabled).toBe(true);
  });
});
