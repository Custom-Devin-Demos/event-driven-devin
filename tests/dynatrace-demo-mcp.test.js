/* global afterAll, beforeAll, describe, expect, test, fetch */

const express = require('express');
const http = require('http');

const dynatraceDemoMcpRoutes = require('../app/routes/dynatrace-demo-mcp');

let server;
let url;

const rpc = (body) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
  body: JSON.stringify(body),
});

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(dynatraceDemoMcpRoutes);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  url = `http://127.0.0.1:${server.address().port}${dynatraceDemoMcpRoutes.MCP_PATH}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

describe('Dynatrace demo stand-in MCP', () => {
  test('initialize negotiates the protocol and advertises tools', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'jest', version: '0' } } });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.result.protocolVersion).toBe('2025-03-26');
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.serverInfo.name).toBe('dynatrace-demo-mcp');
  });

  test('notifications are accepted without a body', async () => {
    const res = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(202);
  });

  test('every tool is labelled as a demo stand-in', async () => {
    const body = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
    const names = body.result.tools.map((tool) => tool.name);
    expect(names).toEqual(['list_problems', 'get_problem_details', 'find_entity_by_name', 'execute_dql']);
    body.result.tools.forEach((tool) => expect(tool.description).toMatch(/^\[DEMO STAND-IN\]/));
  });

  test('list_problems and get_problem_details describe the banking-api problem', async () => {
    const list = await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_problems', arguments: {} } })).json();
    const { problems } = JSON.parse(list.result.content[0].text);
    expect(problems).toHaveLength(1);
    expect(problems[0].rootCauseEntity.name).toBe('banking-api');

    const details = await (await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_problem_details', arguments: { problemId: problems[0].displayId } } })).json();
    expect(details.result.isError).toBe(false);
    const problem = JSON.parse(details.result.content[0].text);
    expect(problem.evidence[0].data.currentP95Ms).toBeGreaterThan(problem.evidence[0].data.baselineP95Ms);
  });

  test('execute_dql answers span queries and flags missing arguments', async () => {
    const spans = await (await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'execute_dql', arguments: { dqlStatement: 'fetch spans | filter service.name == "banking-api"' } } })).json();
    expect(JSON.parse(spans.result.content[0].text).records[0]['span.name']).toBeDefined();

    const missing = await (await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'execute_dql', arguments: {} } })).json();
    expect(missing.result.isError).toBe(true);
  });

  test('unknown methods return a JSON-RPC error and GET is rejected', async () => {
    const body = await (await rpc({ jsonrpc: '2.0', id: 7, method: 'resources/list' })).json();
    expect(body.error.code).toBe(-32601);
    const get = await fetch(url);
    expect(get.status).toBe(405);
  });
});

describe('Dynatrace demo stand-in MCP params handling', () => {
  test('null params get a JSON-RPC answer instead of a 500', async () => {
    const init = await rpc({ jsonrpc: '2.0', id: 8, method: 'initialize', params: null });
    expect(init.status).toBe(200);
    const call = await (await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: null })).json();
    expect(call.error.code).toBe(-32602);
  });
});
