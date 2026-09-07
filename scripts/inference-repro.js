#!/usr/bin/env node
/**
 * Terminal reproduction for the on-call inference scenario.
 *
 * Streams N chat completions against a running demo server and prints the
 * time to first token, decode throughput and total latency for each one, so
 * the trend is visible in a screen recording next to the alert channel.
 *
 *   node scripts/inference-repro.js [--requests 5] [--model deepseek-v3]
 *                                   [--deployment chat-prod] [--max-tokens 64]
 *                                   [--base-url http://localhost:3100]
 */

const http = require('http');
const https = require('https');

const DEFAULTS = {
  requests: 5,
  model: 'deepseek-v3',
  deployment: 'chat-prod',
  maxTokens: 64,
  baseUrl: process.env.ONCALL_BASE_URL || 'http://localhost:3100',
  prompt: 'Explain continuous batching in one paragraph.',
};

const FLAGS = {
  '--requests': 'requests',
  '--model': 'model',
  '--deployment': 'deployment',
  '--max-tokens': 'maxTokens',
  '--base-url': 'baseUrl',
  '--prompt': 'prompt',
};

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 2) {
    const key = FLAGS[argv[i]];
    if (!key) {
      console.error(`Unknown argument: ${argv[i]}`);
      process.exit(1);
    }
    options[key] = argv[i + 1];
  }
  options.requests = parseInt(options.requests, 10);
  options.maxTokens = parseInt(options.maxTokens, 10);
  return options;
}

const dim = (s) => `\u001b[2m${s}\u001b[0m`;
const bold = (s) => `\u001b[1m${s}\u001b[0m`;
const amber = (s) => `\u001b[38;5;208m${s}\u001b[0m`;

function seconds(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Stream one completion, printing tokens as they arrive.
 */
function streamCompletion(options, index) {
  const started = Date.now();
  process.stdout.write(`${bold(`request ${index}`)} ${dim(`${options.model} · ${options.deployment}`)}\n`);

  const spinner = setInterval(() => {
    process.stdout.write(`\r  ${amber('waiting for first token')} ${seconds(Date.now() - started)}   `);
  }, 100);

  const url = new URL('/api/oncall/inference/completions', options.baseUrl);
  const transport = url.protocol === 'https:' ? https : http;
  const body = JSON.stringify({
    model: options.model,
    deployment: options.deployment,
    prompt: options.prompt,
    maxTokens: options.maxTokens,
    stream: true,
  });

  return new Promise((resolve, reject) => {
    const fail = (error) => { clearInterval(spinner); reject(error); };
    const req = transport.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        fail(new Error(`HTTP ${res.statusCode} from ${options.baseUrl}`));
        return;
      }
      res.setEncoding('utf8');
      let buffer = '';
      let ttftMs = 0;
      let tokensPerSecond = 0;
      let completionTokens = 0;
      let printedColumns = 0;

      res.on('data', (data) => {
        buffer += data;
        const frames = buffer.split('\n\n');
        buffer = frames.pop();
        for (const frame of frames) {
          const line = frame.replace(/^data: /, '').trim();
          if (!line || line === '[DONE]') continue;
          const chunk = JSON.parse(line);
          if (chunk.error) {
            fail(new Error(chunk.error.message));
            return;
          }
          if (chunk.ttftMs && !ttftMs) {
            ttftMs = chunk.ttftMs;
            clearInterval(spinner);
            process.stdout.write(`\r  ${amber('TTFT')} ${bold(seconds(ttftMs))}${' '.repeat(20)}\n  `);
          }
          const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
          if (delta && delta.content) {
            if (printedColumns + delta.content.length > 76) {
              process.stdout.write('\n  ');
              printedColumns = 0;
            }
            process.stdout.write(dim(delta.content));
            printedColumns += delta.content.length;
          }
          if (chunk.usage) {
            completionTokens = chunk.usage.completion_tokens;
            tokensPerSecond = chunk.tokensPerSecond;
          }
        }
      });

      res.on('end', () => {
        clearInterval(spinner);
        const totalMs = Date.now() - started;
        process.stdout.write(`\n  ${dim('ttft')} ${seconds(ttftMs)}   ${dim('decode')} ${tokensPerSecond} tok/s`
          + `   ${dim('tokens')} ${completionTokens}   ${dim('total')} ${seconds(totalMs)}\n\n`);
        resolve({ ttftMs, totalMs });
      });
    });

    req.on('error', fail);
    req.end(body);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  console.log(`${bold('POST')} ${options.baseUrl}/api/oncall/inference/completions`);
  console.log(dim(`${options.requests} sequential streaming completions, max_tokens=${options.maxTokens}\n`));

  const runs = [];
  for (let i = 1; i <= options.requests; i++) {
    runs.push(await streamCompletion(options, i));
  }

  console.log(bold('summary'));
  runs.forEach((run, i) => {
    const delta = i === 0 ? '' : dim(`  (+${seconds(run.ttftMs - runs[0].ttftMs)} vs request 1)`);
    console.log(`  request ${i + 1}  ttft ${seconds(run.ttftMs)}  total ${seconds(run.totalMs)}${delta}`);
  });
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
