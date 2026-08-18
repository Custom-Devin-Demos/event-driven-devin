#!/usr/bin/env node

const http = require('http');
const https = require('https');

const DEFAULT_INVARIANTS = ['totalAvailable', 'innerQueryCount'];
const REQUEST_TIMEOUT_MS = 30000;

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !key.startsWith('--') || value === undefined) {
      throw new Error('usage: node scripts/patrol-before-after.js --before URL --after URL --path PATH --runs N [--invariants a,b]');
    }
    options[key.slice(2)] = value;
  }
  for (const key of ['before', 'after', 'path', 'runs']) {
    if (!options[key]) {
      throw new Error(`missing --${key}`);
    }
  }
  if (!/^\/.+/.test(options.path)) {
    throw new Error('--path must start with /');
  }
  if (options.path.startsWith('//')) {
    throw new Error('--path must resolve against the provided origins, not a protocol-relative host');
  }
  if (!/^[1-9]\d*$/.test(options.runs)) {
    throw new Error('--runs must be a positive integer');
  }
  options.runs = Number(options.runs);
  options.invariants = options.invariants
    ? options.invariants.split(',').map((name) => name.trim()).filter(Boolean)
    : DEFAULT_INVARIANTS;
  if (options.invariants.length === 0) {
    throw new Error('--invariants must name at least one field');
  }
  return options;
}

function requestJson(baseUrl, path) {
  const url = new URL(path, `${baseUrl.replace(/\/$/, '')}/`);
  const client = url.protocol === 'https:' ? https : http;
  const startedAt = process.hrtime.bigint();
  return new Promise((resolve, reject) => {
    let settled = false;
    let responseStarted = false;
    const timeout = setTimeout(() => {
      settled = true;
      request.destroy();
      reject(new Error(`${url.href}: request timed out after ${REQUEST_TIMEOUT_MS} ms`));
    }, REQUEST_TIMEOUT_MS);
    const finish = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const request = client.get(url, (response) => {
      responseStarted = true;
      let body = '';
      let ended = false;
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        ended = true;
        const wallClockMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        if (response.statusCode < 200 || response.statusCode >= 300) {
          finish(() => reject(new Error(`${url.href}: returned HTTP ${response.statusCode}`)));
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          finish(() => reject(new Error(`${url.href}: response body is not JSON`)));
          return;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          finish(() => reject(new Error(`${url.href}: response body is not a JSON object`)));
          return;
        }
        if ('totalDurationMs' in parsed
          && (typeof parsed.totalDurationMs !== 'number' || !Number.isFinite(parsed.totalDurationMs))) {
          finish(() => reject(new Error(`${url.href}: totalDurationMs is not a finite number`)));
          return;
        }
        finish(() => resolve({
          body: parsed,
          responseDurationMs: 'totalDurationMs' in parsed ? parsed.totalDurationMs : null,
          wallClockMs,
          usesResponseDuration: 'totalDurationMs' in parsed,
        }));
      });
      response.on('aborted', () => {
        finish(() => reject(new Error(`${url.href}: connection closed before the response completed`)));
      });
      response.on('error', () => {
        finish(() => reject(new Error(`${url.href}: connection closed before the response completed`)));
      });
      response.on('close', () => {
        if (!ended) {
          finish(() => reject(new Error(`${url.href}: connection closed before the response completed`)));
        }
      });
    });
    request.on('error', (error) => {
      const message = responseStarted || error.code === 'ECONNRESET' || error.message === 'socket hang up'
        ? 'connection closed before the response completed'
        : error.message;
      finish(() => reject(new Error(`${url.href}: ${message}`)));
    });
  });
}

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function displayValue(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function formatDuration(value) {
  if (value === 0 || Math.abs(value) >= 1) {
    return value.toFixed(2);
  }
  const decimals = Math.min(20, Math.max(2, Math.ceil(-Math.log10(Math.abs(value))) + 2));
  const fixed = value.toFixed(decimals);
  if (Number(fixed) === 0) {
    return value.toExponential(6);
  }
  const [whole, fraction = ''] = fixed.split('.');
  return `${whole}.${fraction.replace(/0+$/, '').padEnd(2, '0')}`;
}

function formatRow(row, widths) {
  const values = [
    String(row.run),
    `${formatDuration(row.beforeMs)} ms`,
    `${formatDuration(row.afterMs)} ms`,
    ...row.invariants.map(displayValue),
  ];
  return values.map((value, index) => index === 0
    ? value.padStart(widths[index])
    : value.padEnd(widths[index])).join('  ');
}

function tableHeader(invariants, widths, durationSource) {
  const labels = ['run', 'pre-fix code', 'fixed code', ...invariants];
  const line = labels.map((label, index) => index === 0
    ? label.padStart(widths[index])
    : label.padEnd(widths[index])).join('  ');
  return [`Duration source: ${durationSource}`, line].join('\n');
}

async function compareBeforeAfter(options, output = process.stdout) {
  if (options.path.startsWith('//')) {
    throw new Error('--path must not be protocol-relative because it must resolve against the provided origins');
  }
  for (const flag of ['before', 'after']) {
    const url = new URL(options[flag]);
    if (url.pathname !== '/') {
      throw new Error(`--${flag} URL pathname must be "/" because --path is resolved against the origin`);
    }
  }
  const rows = [];
  const baselines = { before: new Map(), after: new Map() };
  let durationSource;
  let widths;
  output.write('Slow Query Patrol before/after\n');

  for (let run = 1; run <= options.runs; run += 1) {
    const first = run % 2 === 1 ? 'before' : 'after';
    const second = first === 'before' ? 'after' : 'before';
    const responses = {};
    responses[first] = await requestJson(options[first], options.path);
    responses[second] = await requestJson(options[second], options.path);
    const source = responses.before.usesResponseDuration && responses.after.usesResponseDuration
      ? 'response totalDurationMs'
      : 'wall-clock around the request';
    if (durationSource && durationSource !== source) {
      throw new Error(`duration source changed on run ${run}: ${durationSource} -> ${source}`);
    }
    durationSource = source;
    const duration = (response) => source === 'response totalDurationMs'
      ? response.responseDurationMs
      : response.wallClockMs;

    const rowInvariants = { before: {}, after: {} };
    for (const side of ['before', 'after']) {
      for (const field of options.invariants) {
        if (!Object.prototype.hasOwnProperty.call(responses[side].body, field)) {
          throw new Error(`${new URL(options[side]).origin}${options.path}: missing invariant field ${field}`);
        }
        const value = responses[side].body[field];
        if (baselines[side].has(field) && !valuesEqual(baselines[side].get(field), value)) {
          throw new Error(`invariant field ${field} drifted on ${side}: ${displayValue(baselines[side].get(field))} -> ${displayValue(value)}`);
        }
        baselines[side].set(field, value);
        rowInvariants[side][field] = value;
      }
    }
    for (const field of options.invariants) {
      if (!valuesEqual(rowInvariants.before[field], rowInvariants.after[field])) {
        throw new Error(`invariant field ${field} differs on run ${run}: before=${displayValue(rowInvariants.before[field])}, after=${displayValue(rowInvariants.after[field])}`);
      }
    }

    const row = {
      run,
      beforeMs: duration(responses.before),
      afterMs: duration(responses.after),
      invariants: options.invariants.map((field) => rowInvariants.before[field]),
    };
    rows.push(row);
    if (!widths) {
      widths = [
        Math.max(3, String(options.runs).length),
        Math.max('pre-fix code'.length, 15),
        Math.max('fixed code'.length, 15),
        ...options.invariants.map((field) => Math.max(field.length, 12)),
      ];
      output.write(`${tableHeader(options.invariants, widths, durationSource)}\n`);
    }
    output.write(`${formatRow(row, widths)}\n`);
  }

  const meanBefore = rows.reduce((sum, row) => sum + row.beforeMs, 0) / rows.length;
  const meanAfter = rows.reduce((sum, row) => sum + row.afterMs, 0) / rows.length;
  const speedup = meanAfter === 0 ? null : meanBefore / meanAfter;
  const speedupText = speedup === null ? 'speedup is not computable' : `speedup: ${speedup.toFixed(2)}x`;
  output.write(`Mean pre-fix: ${formatDuration(meanBefore)} ms, mean fixed: ${formatDuration(meanAfter)} ms, ${speedupText}. Invariants were identical across every run.\n`);
  return { rows, meanBefore, meanAfter, speedup };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await compareBeforeAfter(options);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { compareBeforeAfter, parseArgs, requestJson };
