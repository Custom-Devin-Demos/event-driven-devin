const express = require('express');
const crypto = require('crypto');

// DEMO STAND-IN: a minimal MCP server (streamable HTTP, stateless JSON-RPC) that
// presents the Dell storefront feature flags for the #dell-oncall checkout demo.
// Flag state lives in this process only; changing a flag here never alters the
// storefront, a real flag service, or any production system.

const router = express.Router();

const MCP_PATH = '/mcp/dell-feature-flag';
const SERVER_INFO = { name: 'dell-feature-flag', version: '1.0.0' };
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const ENVIRONMENTS = ['prod', 'staging'];
const STOREFRONT_SERVICE = 'customer-683629b3-web';
const LANE_SCHEMA_FLAG = 'checkout.lane-schema-v2';
const LANE_SCHEMA_RELEASE = 'acme-checkout@1.0.2';
const LANE_SCHEMA_ENABLED_AT = '2026-11-11T02:35:12.000Z';

function seedFlags() {
  return [
    {
      key: LANE_SCHEMA_FLAG,
      name: 'Checkout: lane-schema v2 fulfillment codes',
      description: `Resolve fulfillment lanes in ${STOREFRONT_SERVICE} with the lane-schema v2 codes (cto-na-v2 / stock-na-v2) instead of the v1 codes (cto-na / stock-na).`,
      service: STOREFRONT_SERVICE,
      owner: 'Order Management',
      kind: 'release',
      environments: {
        prod: { enabled: true, rolloutPercent: 100, changedAt: LANE_SCHEMA_ENABLED_AT, changedBy: `release-pipeline (${LANE_SCHEMA_RELEASE})`, previous: { enabled: false, rolloutPercent: 0 } },
        staging: { enabled: true, rolloutPercent: 100, changedAt: '2026-11-10T19:02:44.000Z', changedBy: 'release-pipeline (acme-checkout@1.0.2-rc.1)', previous: { enabled: false, rolloutPercent: 0 } },
      },
      history: [
        { changeId: 'FF-CHG-4E1A0C72', environment: 'prod', at: LANE_SCHEMA_ENABLED_AT, by: `release-pipeline (${LANE_SCHEMA_RELEASE})`, from: { enabled: false, rolloutPercent: 0 }, to: { enabled: true, rolloutPercent: 100 }, reason: `Enable lane-schema v2 with release ${LANE_SCHEMA_RELEASE}` },
        { changeId: 'FF-CHG-2B77D9E0', environment: 'staging', at: '2026-11-10T19:02:44.000Z', by: 'release-pipeline (acme-checkout@1.0.2-rc.1)', from: { enabled: false, rolloutPercent: 0 }, to: { enabled: true, rolloutPercent: 100 }, reason: 'Stage lane-schema v2 ahead of the 1.0.2 release' },
      ],
    },
    {
      key: 'checkout.express-delivery-upsell',
      name: 'Checkout: express delivery upsell',
      description: 'Offer the express delivery lane on the cart page when the stock lane can fulfil the order.',
      service: STOREFRONT_SERVICE,
      owner: 'Storefront Growth',
      kind: 'experiment',
      environments: {
        prod: { enabled: true, rolloutPercent: 50, changedAt: '2026-10-28T16:40:03.000Z', changedBy: 'r.patel', previous: { enabled: true, rolloutPercent: 25 } },
        staging: { enabled: true, rolloutPercent: 100, changedAt: '2026-10-21T09:15:27.000Z', changedBy: 'r.patel', previous: { enabled: false, rolloutPercent: 0 } },
      },
      history: [
        { changeId: 'FF-CHG-9C03A1B5', environment: 'prod', at: '2026-10-28T16:40:03.000Z', by: 'r.patel', from: { enabled: true, rolloutPercent: 25 }, to: { enabled: true, rolloutPercent: 50 }, reason: 'Widen the express upsell experiment to 50%' },
      ],
    },
    {
      key: 'storefront.saved-items-badge',
      name: 'Storefront: saved items badge',
      description: 'Show the saved-items count badge in the storefront header.',
      service: STOREFRONT_SERVICE,
      owner: 'Storefront UX',
      kind: 'release',
      environments: {
        prod: { enabled: true, rolloutPercent: 100, changedAt: '2026-09-30T13:05:51.000Z', changedBy: 'release-pipeline (acme-checkout@1.0.0)', previous: { enabled: false, rolloutPercent: 0 } },
        staging: { enabled: true, rolloutPercent: 100, changedAt: '2026-09-29T11:48:10.000Z', changedBy: 'release-pipeline (acme-checkout@1.0.0-rc.3)', previous: { enabled: false, rolloutPercent: 0 } },
      },
      history: [],
    },
  ];
}

let flags = seedFlags();

function resetFlags() {
  flags = seedFlags();
}

const findFlag = (key) => flags.find((flag) => flag.key === key);
const unknownFlag = (key) => ({ error: `Flag ${key} not found. Known flags: ${flags.map((flag) => flag.key).join(', ')}.` });
const unknownEnvironment = (environment) => ({ error: `Environment ${environment} not found. Environments: ${ENVIRONMENTS.join(', ')}.` });
const newChangeId = () => `FF-CHG-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

function summarize(flag, environment) {
  const state = flag.environments[environment];
  return {
    key: flag.key,
    name: flag.name,
    service: flag.service,
    owner: flag.owner,
    kind: flag.kind,
    environment,
    enabled: state.enabled,
    rolloutPercent: state.rolloutPercent,
    changedAt: state.changedAt,
    changedBy: state.changedBy,
  };
}

function details(flag) {
  return {
    key: flag.key,
    name: flag.name,
    description: flag.description,
    service: flag.service,
    owner: flag.owner,
    kind: flag.kind,
    environments: flag.environments,
    history: flag.history,
    rollbackAvailable: Object.fromEntries(ENVIRONMENTS.map((env) => [env, Boolean(flag.environments[env].previous)])),
  };
}

function applyChange(flag, environment, to, by, reason, now) {
  const state = flag.environments[environment];
  const from = { enabled: state.enabled, rolloutPercent: state.rolloutPercent };
  const change = { changeId: newChangeId(), environment, at: new Date(now).toISOString(), by, from, to, reason };
  flag.environments[environment] = { ...to, changedAt: change.at, changedBy: by, previous: from };
  flag.history.unshift(change);
  return {
    status: 'applied',
    change,
    flag: summarize(flag, environment),
    propagation: { expectedWithinSeconds: 30, note: `${flag.service} evaluates ${flag.key} on every request; no deploy or restart is needed.` },
  };
}

const TOOLS = [
  {
    name: 'list_flags',
    description: 'List the feature flags of the Dell.com storefront with their state in one environment.',
    inputSchema: {
      type: 'object',
      properties: {
        environment: { type: 'string', enum: ENVIRONMENTS, default: 'prod' },
        service: { type: 'string', description: `Only flags owned by this service, e.g. ${STOREFRONT_SERVICE}` },
      },
      additionalProperties: false,
    },
    readOnly: true,
    handler: ({ environment = 'prod', service }) => {
      if (!ENVIRONMENTS.includes(environment)) return unknownEnvironment(environment);
      const matching = flags.filter((flag) => !service || flag.service === service);
      return { environment, totalCount: matching.length, flags: matching.map((flag) => summarize(flag, environment)) };
    },
  },
  {
    name: 'get_flag',
    description: 'Get one feature flag with its per-environment state, change history and whether a rollback is available.',
    inputSchema: {
      type: 'object',
      properties: { flagKey: { type: 'string', description: `Flag key such as ${LANE_SCHEMA_FLAG}` } },
      required: ['flagKey'],
      additionalProperties: false,
    },
    readOnly: true,
    handler: ({ flagKey }) => {
      const flag = findFlag(flagKey);
      return flag ? details(flag) : unknownFlag(flagKey);
    },
  },
  {
    name: 'set_flag',
    description: 'Enable or disable a feature flag in an environment. Changes production traffic immediately; record a reason.',
    inputSchema: {
      type: 'object',
      properties: {
        flagKey: { type: 'string' },
        enabled: { type: 'boolean' },
        environment: { type: 'string', enum: ENVIRONMENTS, default: 'prod' },
        rolloutPercent: { type: 'integer', minimum: 0, maximum: 100, description: 'Defaults to 100 when enabling and 0 when disabling' },
        reason: { type: 'string', description: 'Why the flag is changing (incident reference, ticket, approver)' },
      },
      required: ['flagKey', 'enabled', 'reason'],
      additionalProperties: false,
    },
    readOnly: false,
    handler: ({ flagKey, enabled, environment = 'prod', rolloutPercent, reason }, now) => {
      const flag = findFlag(flagKey);
      if (!flag) return unknownFlag(flagKey);
      if (!ENVIRONMENTS.includes(environment)) return unknownEnvironment(environment);
      const percent = Number.isInteger(rolloutPercent) ? rolloutPercent : enabled ? 100 : 0;
      return applyChange(flag, environment, { enabled: Boolean(enabled), rolloutPercent: percent }, 'devin (approved by on-call)', reason, now);
    },
  },
  {
    name: 'rollback_flag',
    description: 'Roll a feature flag back to its previous state in an environment (the state before its last change). Changes production traffic immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        flagKey: { type: 'string' },
        environment: { type: 'string', enum: ENVIRONMENTS, default: 'prod' },
        reason: { type: 'string', description: 'Why the flag is rolled back (incident reference, ticket, approver)' },
      },
      required: ['flagKey', 'reason'],
      additionalProperties: false,
    },
    readOnly: false,
    handler: ({ flagKey, environment = 'prod', reason }, now) => {
      const flag = findFlag(flagKey);
      if (!flag) return unknownFlag(flagKey);
      if (!ENVIRONMENTS.includes(environment)) return unknownEnvironment(environment);
      const { previous } = flag.environments[environment];
      if (!previous) return { error: `Flag ${flagKey} has no previous state in ${environment} to roll back to.` };
      return applyChange(flag, environment, { ...previous }, 'devin (approved by on-call)', reason, now);
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
  const { id, method } = message;
  const params = message.params || {};

  if (method === 'initialize') {
    const requested = params.protocolVersion;
    return rpcResult(id, {
      protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: `Dell feature flag service for the Dell.com storefront (${STOREFRONT_SERVICE}). list_flags and get_flag are read-only; set_flag and rollback_flag change live traffic and need an approved reason.`,
    });
  }
  if (isNotification) return null;
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') {
    return rpcResult(id, {
      tools: TOOLS.map(({ name, description, inputSchema, readOnly }) => ({
        name,
        description,
        inputSchema,
        annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly },
      })),
    });
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
module.exports.LANE_SCHEMA_FLAG = LANE_SCHEMA_FLAG;
module.exports.resetFlags = resetFlags;
