const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

/**
 * Served model configurations keyed by the model id the client sends.
 */
const MODEL_CONFIGS = {
  'deepseek-v3': { label: 'DeepSeek-V3', contextTokens: 163840, replicas: 8, tokensPerSecond: 46 },
  'qwen3-32b': { label: 'Qwen3-32B', contextTokens: 131072, replicas: 4, tokensPerSecond: 62 },
  'llama-3.3-70b': { label: 'Llama-3.3-70B-Instruct', contextTokens: 131072, replicas: 6, tokensPerSecond: 38 },
};

/**
 * Deployments visible in the serving console.
 */
const DEPLOYMENTS = [
  { id: 'dep_8f21', model: 'deepseek-v3', name: 'chat-prod', replicas: 8, status: 'running' },
  { id: 'dep_4c07', model: 'qwen3-32b', name: 'autocomplete-prod', replicas: 4, status: 'running' },
  { id: 'dep_1b93', model: 'llama-3.3-70b', name: 'batch-eval', replicas: 6, status: 'running' },
];

/**
 * In-process radix prefix cache: every completion stores the KV block
 * descriptor for its prompt prefix here so later requests sharing that
 * prefix skip prefill. Hydrated from the warm-start snapshot at startup.
 */
const prefixCache = new Map();

/**
 * Blocks admitted at runtime (one per completion) are session blocks: they
 * only stay hot for a short window, after which the allocator treats them as
 * settled and they drop out of the residency-probe set. The warm-start
 * baseline never expires.
 */
const RUNTIME_BLOCK_TTL_MS = 60 * 1000;
const runtimeKeys = new Set();

/**
 * Keys of blocks admitted by synthetic probe traffic, so releasing them never
 * touches blocks admitted by real demo traffic.
 */
const syntheticKeys = new Set();

/**
 * The KV page table is replicated across the tensor-parallel workers. Blocks
 * admitted before the last checkpoint are known to be resident on every
 * worker, so one probe settles them. Session blocks are still propagating and
 * must be probed on each worker individually.
 */
const PAGE_TABLE_WORKERS = 16;

function expireRuntimeBlocks() {
  const cutoff = Date.now() - RUNTIME_BLOCK_TTL_MS;
  let expired = 0;
  for (const key of runtimeKeys) {
    const block = prefixCache.get(key);
    if (!block || block.admittedAt < cutoff) {
      if (prefixCache.delete(key)) expired++;
      runtimeKeys.delete(key);
      syntheticKeys.delete(key);
    }
  }
  if (expired > 0) {
    logger.info('Settled session KV blocks dropped from prefix cache', {
      expired,
      blocks: prefixCache.size,
      service: 'inference-gateway',
    });
  }
}

function makeBlock(model, promptTokens) {
  const pages = Buffer.alloc(256 * 1024);
  crypto.randomFillSync(pages, 0, 1024);
  return {
    model,
    promptTokens,
    admittedAt: Date.now(),
    pages,
    digest: crypto.createHash('sha256').update(pages).digest('hex'),
  };
}

function hydrateFromWarmStart() {
  const models = Object.keys(MODEL_CONFIGS);
  for (let i = 0; i < 240; i++) {
    const key = `warmstart-${String(i).padStart(4, '0')}`;
    prefixCache.set(key, makeBlock(models[i % models.length], 512 + (i % 96) * 32));
  }
  logger.info('Prefix cache hydrated from warm-start snapshot', {
    blocks: prefixCache.size,
    service: 'inference-gateway',
  });
}
hydrateFromWarmStart();

/**
 * Probe a cached block for residency on a page-table worker (~25ms per probe).
 */
async function probeBlock(block) {
  await new Promise((resolve) => setTimeout(resolve, 22 + Math.random() * 8));
  const digest = crypto.createHash('sha256').update(block.pages).digest('hex');
  return digest === block.digest;
}

/**
 * Resolve how much of this prompt's prefix is already cached. Every cached
 * block is probed for residency before it is reused so a block the allocator
 * has already reclaimed can never be decoded against.
 */
async function resolveCachedPrefix(model) {
  let cachedTokens = 0;
  for (const [key, block] of prefixCache) {
    const workers = runtimeKeys.has(key) ? PAGE_TABLE_WORKERS : 1;
    let resident = true;
    for (let i = 0; i < workers; i++) {
      resident = (await probeBlock(block)) && resident;
    }
    if (resident && block.model === model) {
      cachedTokens += 16;
    }
  }
  return cachedTokens;
}

/**
 * Retrieve the configuration for a served model id.
 */
function getModelConfig(model) {
  return MODEL_CONFIGS[String(model || '').toLowerCase()] || MODEL_CONFIGS['deepseek-v3'];
}

/**
 * Canned completion body. The demo never calls a real model; the sampled text
 * only has to decode over a realistic number of steps.
 */
const COMPLETION_BODY = [
  'Continuous batching lets the scheduler admit new requests into a running',
  'batch at every decode step instead of waiting for the slowest sequence in',
  'the batch to finish. Each step the engine reclaims the slots held by',
  'finished sequences, admits whatever is queued, and runs one fused forward',
  'pass over the merged batch. Throughput rises because the accelerator stops',
  'idling behind stragglers, and tail latency improves because a short request',
  'no longer waits out a long one.',
].join(' ');

function tokenize(text) {
  return text.split(/(\s+)/).filter((piece) => piece.length > 0);
}

function estimatePromptTokens(prompt) {
  const chars = String(prompt || '').length;
  return Math.max(8, Math.ceil(chars / 4));
}

/**
 * Run a chat completion. `options.onFirstToken` and `options.onToken` are
 * invoked as the response is sampled so the caller can stream; both are
 * optional and the full text is returned either way.
 */
async function runCompletion(data, options = {}) {
  const startTime = Date.now();
  const completionId = `cmpl_${uuidv4().replace(/-/g, '').slice(0, 24)}`;
  const model = String(data.model || 'deepseek-v3').toLowerCase();
  const config = getModelConfig(model);
  const maxTokens = Math.min(parseInt(data.maxTokens, 10) || 64, 512);

  logger.info('Chat completion accepted', {
    completionId,
    model,
    deployment: data.deployment,
    promptChars: String(data.prompt || '').length,
    blocks: prefixCache.size,
    service: 'inference-gateway',
    route: '/api/oncall/inference/completions',
  });

  try {
    expireRuntimeBlocks();
    const promptTokens = estimatePromptTokens(data.prompt);
    const cachedPrefixTokens = await resolveCachedPrefix(model);
    const ttftMs = Date.now() - startTime;
    if (typeof options.onFirstToken === 'function') options.onFirstToken(ttftMs);

    const tokens = tokenize(COMPLETION_BODY).slice(0, maxTokens);
    const stepMs = Math.round(1000 / config.tokensPerSecond);
    let text = '';
    for (const token of tokens) {
      await new Promise((resolve) => setTimeout(resolve, stepMs));
      text += token;
      if (typeof options.onToken === 'function') options.onToken(token);
    }

    prefixCache.set(completionId, makeBlock(model, promptTokens));
    runtimeKeys.add(completionId);
    if (options.synthetic) syntheticKeys.add(completionId);

    const duration = Date.now() - startTime;
    const completionTokens = tokens.length;
    const decodeMs = Math.max(1, duration - ttftMs);

    incrementMetric('inference.completion.success', {
      route: '/api/oncall/inference/completions',
      model,
    });
    recordTiming('inference.ttft', ttftMs, {
      route: '/api/oncall/inference/completions',
      model,
    });
    recordTiming('inference.completion.latency', duration, {
      route: '/api/oncall/inference/completions',
    });

    logger.info('Chat completion finished', {
      completionId,
      ttftMs,
      durationMs: duration,
      completionTokens,
      blocks: prefixCache.size,
      rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      service: 'inference-gateway',
    });

    return {
      success: true,
      id: completionId,
      object: 'chat.completion',
      model: config.label,
      deployment: data.deployment || DEPLOYMENTS[0].name,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        cached_prefix_tokens: cachedPrefixTokens,
      },
      ttftMs,
      tokensPerSecond: Math.round((completionTokens / decodeMs) * 1000 * 10) / 10,
      status: 'completed',
      completedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('inference.completion.failure', {
      route: '/api/oncall/inference/completions',
      errorClass: error.name,
    });
    recordTiming('inference.completion.latency', duration, {
      route: '/api/oncall/inference/completions',
      error: 'true',
    });

    logger.error('Chat completion failed', {
      completionId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      model,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/oncall/inference/completions',
        service: 'inference-gateway',
        model,
        ...(options.synthetic ? { synthetic_probe: 'true' } : {}),
      },
      extra: { completionId, deployment: data.deployment },
    });

    throw error;
  }
}

/**
 * Release blocks accumulated by synthetic probe traffic, so probe bursts
 * don't permanently grow the cache. User traffic and the warm-start baseline
 * are untouched.
 */
function releaseAccumulatedBlocks() {
  let released = 0;
  for (const key of syntheticKeys) {
    if (prefixCache.delete(key)) released++;
    runtimeKeys.delete(key);
  }
  syntheticKeys.clear();
  if (released > 0) {
    logger.info('Synthetic-probe KV blocks released from prefix cache', {
      released,
      blocks: prefixCache.size,
      service: 'inference-gateway',
    });
  }
  return released;
}

module.exports = { runCompletion, MODEL_CONFIGS, DEPLOYMENTS, releaseAccumulatedBlocks };
