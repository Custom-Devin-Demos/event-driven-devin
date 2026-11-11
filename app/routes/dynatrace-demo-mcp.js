const express = require('express');

// DEMO STAND-IN: a minimal MCP server (streamable HTTP, stateless, JSON responses)
// that answers with synthetic Dynatrace-shaped data for the on-call banking alert.
// It is not Dynatrace's product or API and never contacts a Dynatrace tenant.

const router = express.Router();

const MCP_PATH = '/mcp/dynatrace-demo';
const SERVER_INFO = { name: 'dynatrace-demo-mcp', version: '1.0.0' };
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LABEL = '[DEMO STAND-IN]';

const SERVICE = 'banking-api';
const SERVICE_ENTITY_ID = 'SERVICE-6F1C3B2A9D04E781';
const ENDPOINT = 'POST /api/oncall/banking/transfer';
const PROBLEM_ID = '-3829104726651187402_1794400800000V2';
const PROBLEM_DISPLAY_ID = 'P-26111142';

const minutesAgo = (now, minutes) => new Date(now - minutes * 60 * 1000).toISOString();

function problemSummary(now) {
  return {
    problemId: PROBLEM_ID,
    displayId: PROBLEM_DISPLAY_ID,
    title: `Response time degradation on ${ENDPOINT}`,
    status: 'OPEN',
    severityLevel: 'PERFORMANCE',
    impactLevel: 'SERVICES',
    startTime: minutesAgo(now, 18),
    rootCauseEntity: { entityId: SERVICE_ENTITY_ID, name: SERVICE, type: 'SERVICE' },
    affectedEntities: [{ entityId: SERVICE_ENTITY_ID, name: SERVICE, type: 'SERVICE' }],
  };
}

function problemDetails(now) {
  return {
    ...problemSummary(now),
    evidence: [
      {
        evidenceType: 'TRANSACTIONAL',
        displayName: 'Response time degradation',
        entity: { name: ENDPOINT, type: 'SERVICE_METHOD' },
        data: {
          baselineP95Ms: 412,
          currentP95Ms: 9480,
          currentMedianMs: 9120,
          failureRatePercent: 0.0,
          requestsPerMinute: 14,
        },
      },
      {
        evidenceType: 'EVENT',
        displayName: 'Response time breakdown',
        data: {
          note: 'Most of the response time is spent in one downstream call; the request itself fails at the baseline rate.',
          topContributors: responseTimeBreakdown().children.slice(0, 3),
        },
      },
    ],
    impactAnalysis: {
      impactedServiceMethods: [ENDPOINT],
      affectedRequestsLast15m: 211,
      errorRateChange: 'none',
    },
    recentDeployments: [],
    davisAnalysis: 'Response time of the transfer endpoint rose from ~0.4s to ~9.5s p95. Error rate and throughput are unchanged. No deployment or infrastructure event correlates with the start of the problem; the added time is concentrated in the compliance screening call chain.',
  };
}

function responseTimeBreakdown() {
  return {
    span: ENDPOINT,
    service: SERVICE,
    p95Ms: 9480,
    children: [
      { span: 'compliance.screening', p95Ms: 8790, shareOfResponseTimePercent: 92.7, waitTimeMs: 8310, callsPerRequest: 6 },
      { span: 'payments.gateway.submit', p95Ms: 402, shareOfResponseTimePercent: 4.2, waitTimeMs: 0, callsPerRequest: 1 },
      { span: 'risk.score', p95Ms: 41, shareOfResponseTimePercent: 0.4, waitTimeMs: 0, callsPerRequest: 1 },
      { span: 'fees.calculate', p95Ms: 3, shareOfResponseTimePercent: 0.0, waitTimeMs: 0, callsPerRequest: 1 },
    ],
  };
}

function dqlRecords(query, now) {
  const q = String(query || '').toLowerCase();
  if (q.includes('fetch logs')) {
    return [
      { timestamp: minutesAgo(now, 2), loglevel: 'INFO', 'service.name': SERVICE, content: 'Transfer completed', durationMs: 9503, endpoint: ENDPOINT },
      { timestamp: minutesAgo(now, 4), loglevel: 'INFO', 'service.name': SERVICE, content: 'Transfer completed', durationMs: 9318, endpoint: ENDPOINT },
      { timestamp: minutesAgo(now, 7), loglevel: 'INFO', 'service.name': SERVICE, content: 'Transfer completed', durationMs: 9611, endpoint: ENDPOINT },
    ];
  }
  if (q.includes('fetch spans')) {
    return responseTimeBreakdown().children.map((child) => ({
      'service.name': SERVICE,
      'endpoint.name': ENDPOINT,
      'span.name': child.span,
      'p95(duration)': `${child.p95Ms}ms`,
      'avg(wait_time)': `${child.waitTimeMs}ms`,
      'calls_per_request': child.callsPerRequest,
    }));
  }
  const timeframe = [];
  for (let m = 60; m >= 0; m -= 5) {
    timeframe.push({ timestamp: minutesAgo(now, m), 'p95(response_time)': m > 18 ? `${400 + (m % 3) * 12}ms` : `${9300 + (m % 4) * 60}ms` });
  }
  return timeframe.map((row) => ({ 'service.name': SERVICE, 'endpoint.name': ENDPOINT, ...row }));
}

const TOOLS = [
  {
    name: 'list_problems',
    description: `${LABEL} List Davis problems in the environment (synthetic data, not a real Dynatrace tenant).`,
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['OPEN', 'CLOSED', 'ALL'], default: 'OPEN' },
        timeframe: { type: 'string', default: '2h', description: 'Look-back window, e.g. 30m, 2h, 24h' },
      },
      additionalProperties: false,
    },
    handler: ({ status = 'OPEN' }, now) => ({ totalCount: status === 'CLOSED' ? 0 : 1, problems: status === 'CLOSED' ? [] : [problemSummary(now)] }),
  },
  {
    name: 'get_problem_details',
    description: `${LABEL} Get a Davis problem with evidence, response-time breakdown and impact (synthetic data).`,
    inputSchema: {
      type: 'object',
      properties: { problemId: { type: 'string', description: 'Problem ID or display ID such as P-26111142' } },
      required: ['problemId'],
      additionalProperties: false,
    },
    handler: ({ problemId }, now) => {
      if (problemId !== PROBLEM_ID && problemId !== PROBLEM_DISPLAY_ID) {
        return { error: `Problem ${problemId} not found. Open problems: ${PROBLEM_DISPLAY_ID}.` };
      }
      return problemDetails(now);
    },
  },
  {
    name: 'find_entity_by_name',
    description: `${LABEL} Find a monitored entity (service, host, process) by name (synthetic data).`,
    inputSchema: {
      type: 'object',
      properties: { entityName: { type: 'string' } },
      required: ['entityName'],
      additionalProperties: false,
    },
    handler: ({ entityName }) => (String(entityName).toLowerCase().includes('banking')
      ? { entities: [{ entityId: SERVICE_ENTITY_ID, name: SERVICE, type: 'SERVICE', technology: 'Node.js', serviceMethods: [ENDPOINT] }] }
      : { entities: [] }),
  },
  {
    name: 'execute_dql',
    description: `${LABEL} Run a DQL query (fetch logs / fetch spans / timeseries) against synthetic Grail data for ${SERVICE}.`,
    inputSchema: {
      type: 'object',
      properties: { dqlStatement: { type: 'string' } },
      required: ['dqlStatement'],
      additionalProperties: false,
    },
    handler: ({ dqlStatement }, now) => {
      const records = dqlRecords(dqlStatement, now);
      return { dqlStatement, recordCount: records.length, scannedBytes: 48211904, records };
    },
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

function handleMessage(message, now) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return rpcError(message && message.id, -32600, 'Invalid Request');
  }
  const isNotification = message.id === undefined || message.id === null;
  const { id, method, params = {} } = message;

  if (method === 'initialize') {
    const requested = params.protocolVersion;
    return rpcResult(id, {
      protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: 'DEMO STAND-IN for a Dynatrace MCP server. All data is synthetic.',
    });
  }
  if (isNotification) return null;
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  }
  if (method === 'tools/call') {
    const tool = TOOLS_BY_NAME.get(params.name);
    if (!tool) return rpcError(id, -32602, `Unknown tool: ${params.name}`);
    const args = params.arguments || {};
    const missing = (tool.inputSchema.required || []).filter((key) => args[key] === undefined);
    if (missing.length) {
      return rpcResult(id, { content: [{ type: 'text', text: `Missing required argument(s): ${missing.join(', ')}` }], isError: true });
    }
    const payload = tool.handler(args, now);
    return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: Boolean(payload.error) });
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

router.post(MCP_PATH, (req, res) => {
  const now = Date.now();
  const body = req.body;
  const messages = Array.isArray(body) ? body : [body];
  const responses = messages.map((message) => handleMessage(message, now)).filter(Boolean);
  if (!responses.length) return res.status(202).end();
  return res.json(Array.isArray(body) ? responses : responses[0]);
});

router.all(MCP_PATH, (_req, res) => {
  res.set('Allow', 'POST').status(405).json(rpcError(null, -32000, 'Method not allowed'));
});

module.exports = router;
module.exports.MCP_PATH = MCP_PATH;
