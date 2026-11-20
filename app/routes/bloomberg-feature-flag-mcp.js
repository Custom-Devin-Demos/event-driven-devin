const express = require('express');
const crypto = require('crypto');

// DEMO STAND-IN: a minimal MCP server (streamable HTTP, stateless JSON-RPC) that
// presents the auction bidding feature flags for the #bloomberg-oncall demo.
// set_flag and disable_flag return a change record but never store it, so every
// alert run sees the seeded state again; nothing here alters the bidding page, a
// real flag service, or any production system.

const router = express.Router();

const MCP_PATH = '/mcp/bloomberg-feature-flag';
const SERVER_INFO = { name: 'bloomberg-feature-flag', version: '1.0.0' };
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const ENVIRONMENTS = ['prod', 'staging'];
const AUCTION_SERVICE = 'customer-5e2f9a41-auctions';
const BID_LIMITS_FLAG = 'auctions.bid-limits-v2';
const BID_LIMITS_RELEASE = 'auction-gateway@2026.11.3';
const BID_LIMITS_ENABLED_AT = '2026-11-18T09:12:40.000Z';
const off = { enabled: false, rolloutPercent: 0 };
const on = { enabled: true, rolloutPercent: 100 };

function seedFlags() {
  return [
    {
      key: BID_LIMITS_FLAG,
      name: 'Auctions: bid-limits v2 lookup',
      description: `Resolve dealer bid limits in ${AUCTION_SERVICE} from the v2 limits table (keyed by issuer and maturity bucket) instead of the v1 table (keyed by ISIN).`,
      service: AUCTION_SERVICE,
      owner: 'Fixed Income Auctions',
      kind: 'release',
      environments: {
        prod: { ...on, changedAt: BID_LIMITS_ENABLED_AT, changedBy: `release-pipeline (${BID_LIMITS_RELEASE})`, previous: off },
        staging: { ...on, changedAt: '2026-11-17T15:31:09.000Z', changedBy: `release-pipeline (${BID_LIMITS_RELEASE}-rc.1)`, previous: off },
      },
      history: [
        { changeId: 'FF-CHG-7A31C0D4', environment: 'prod', at: BID_LIMITS_ENABLED_AT, by: `release-pipeline (${BID_LIMITS_RELEASE})`, from: off, to: on, reason: 'Roll out bid-limits v2 with the 2026.11.3 gateway release' },
        { changeId: 'FF-CHG-1D90B6E2', environment: 'staging', at: '2026-11-17T15:31:09.000Z', by: `release-pipeline (${BID_LIMITS_RELEASE}-rc.1)`, from: off, to: on, reason: 'Staging soak for bid-limits v2' },
      ],
    },
    {
      key: 'auctions.indicative-cover-ratio',
      name: 'Auctions: indicative cover ratio',
      description: 'Show the indicative bid-to-cover ratio on the auction calendar while the bidding window is open.',
      service: AUCTION_SERVICE,
      owner: 'Fixed Income Auctions',
      kind: 'experiment',
      environments: {
        prod: { enabled: true, rolloutPercent: 50, changedAt: '2026-11-04T14:20:11.000Z', changedBy: 'k.osei', previous: { enabled: true, rolloutPercent: 25 } },
        staging: { ...on, changedAt: '2026-10-29T10:02:45.000Z', changedBy: 'k.osei', previous: off },
      },
      history: [
        { changeId: 'FF-CHG-5C22E8F1', environment: 'prod', at: '2026-11-04T14:20:11.000Z', by: 'k.osei', from: { enabled: true, rolloutPercent: 25 }, to: { enabled: true, rolloutPercent: 50 }, reason: 'Widen the cover-ratio experiment' },
      ],
    },
    {
      key: 'auctions.bid-ticket-keyboard-shortcuts',
      name: 'Auctions: bid ticket keyboard shortcuts',
      description: 'Enable keyboard shortcuts on the bid ticket.',
      service: AUCTION_SERVICE,
      owner: 'Fixed Income UX',
      kind: 'release',
      environments: {
        prod: { ...on, changedAt: '2026-10-07T12:44:30.000Z', changedBy: 'release-pipeline (auction-gateway@2026.10.1)', previous: off },
        staging: { ...on, changedAt: '2026-10-06T09:18:02.000Z', changedBy: 'release-pipeline (auction-gateway@2026.10.1-rc.2)', previous: off },
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
  };
}

function applyChange(flag, environment, to, by, reason, now) {
  const state = flag.environments[environment];
  const from = { enabled: state.enabled, rolloutPercent: state.rolloutPercent };
  const change = { changeId: newChangeId(), environment, at: new Date(now).toISOString(), by, from, to, reason };
  return {
    status: 'applied',
    change,
    flag: { ...summarize(flag, environment), ...to, changedAt: change.at, changedBy: by },
    propagation: { expectedWithinSeconds: 30, note: `${flag.service} evaluates ${flag.key} on every request; no deploy or restart is needed.` },
  };
}

const TOOLS = [
  {
    name: 'list_flags',
    description: 'List the feature flags of the auction bidding service with their state in one environment.',
    inputSchema: {
      type: 'object',
      properties: {
        environment: { type: 'string', enum: ENVIRONMENTS, default: 'prod' },
        service: { type: 'string', description: `Only flags owned by this service, e.g. ${AUCTION_SERVICE}` },
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
    description: 'Get one feature flag with its per-environment state (current and previous) and change history.',
    inputSchema: {
      type: 'object',
      properties: { flagKey: { type: 'string', description: `Flag key such as ${BID_LIMITS_FLAG}` } },
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
    name: 'disable_flag',
    description: 'Turn a feature flag off in an environment (kill switch). Changes production traffic immediately; record a reason.',
    inputSchema: {
      type: 'object',
      properties: {
        flagKey: { type: 'string' },
        environment: { type: 'string', enum: ENVIRONMENTS, default: 'prod' },
        reason: { type: 'string', description: 'Why the flag is being disabled (incident reference, ticket, approver)' },
      },
      required: ['flagKey', 'reason'],
      additionalProperties: false,
    },
    readOnly: false,
    handler: ({ flagKey, environment = 'prod', reason }, now) => {
      const flag = findFlag(flagKey);
      if (!flag) return unknownFlag(flagKey);
      if (!ENVIRONMENTS.includes(environment)) return unknownEnvironment(environment);
      if (!flag.environments[environment].enabled) {
        return { status: 'unchanged', flag: summarize(flag, environment), note: `${flagKey} is already disabled in ${environment}.` };
      }
      return applyChange(flag, environment, { enabled: false, rolloutPercent: 0 }, 'devin (approved by on-call)', reason, now);
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
      instructions: `Feature flag service for auction bidding (${AUCTION_SERVICE}). list_flags and get_flag are read-only; set_flag and disable_flag change live traffic and need an approved reason.`,
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
module.exports.BID_LIMITS_FLAG = BID_LIMITS_FLAG;
module.exports.resetFlags = resetFlags;
