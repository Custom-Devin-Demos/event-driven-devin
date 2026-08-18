#!/usr/bin/env node

const fs = require('fs');

const TOP_LEVEL_KEYS = new Set([
  'mode',
  'window',
  'windowNote',
  'rows',
  'filed',
  'alreadyTracked',
  'backtestProject',
  'fix',
]);
const BANNED_WORDS = [
  'surprisingly',
  'dramatically',
  'massively',
  'actually',
  'simply',
  'obviously',
  'of course',
  'turns out',
  'interestingly',
  'worth noting',
  'critical',
  'huge',
  'painful',
  'eye-watering',
];

function fail(field, message) {
  throw new Error(`${field}: ${message}`);
}

function validateString(value, field) {
  if (typeof value !== 'string') {
    fail(field, 'must be a string');
  }
  if (value.includes('](')) {
    fail(field, 'must not contain markdown links');
  }
  if (value.includes('—')) {
    fail(field, 'must not contain an em dash');
  }
  const banned = BANNED_WORDS.find((word) => new RegExp(`\\b${word}\\b`, 'i').test(value));
  if (banned) {
    fail(field, `contains banned word "${banned}"`);
  }
}

function validateControlCharacters(value, field, characters) {
  for (const character of characters) {
    if (value.includes(character)) {
      fail(field, `must not contain "${character}"`);
    }
  }
}

function validateUrl(value, field) {
  validateString(value, field);
  if (!value.startsWith('https://')) {
    fail(field, 'must start with https://');
  }
}

function validateFinite(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(field, 'must be a finite number');
  }
}

function validateIssue(issue, field) {
  if (!issue || typeof issue !== 'object' || Array.isArray(issue)) {
    fail(field, 'must be an object');
  }
  for (const key of ['id', 'url', 'title']) {
    if (!(key in issue)) {
      fail(`${field}.${key}`, 'is required');
    }
  }
  validateString(issue.id, `${field}.id`);
  validateUrl(issue.url, `${field}.url`);
  validateString(issue.title, `${field}.title`);
  validateControlCharacters(issue.id, `${field}.id`, ['<', '>', '|']);
  validateControlCharacters(issue.title, `${field}.title`, ['<', '>', '|']);
}

function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('input', 'must be an object');
  }
  if (Object.prototype.hasOwnProperty.call(input, 'ranking')) {
    fail('ranking', 'must not be supplied because the ranking is generated');
  }
  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      fail(key, 'is not allowed');
    }
  }
  for (const key of ['mode', 'window', 'windowNote', 'rows', 'filed', 'alreadyTracked', 'fix']) {
    if (!(key in input)) {
      fail(key, 'is required');
    }
  }
  validateString(input.mode, 'mode');
  if (!['PRODUCTION', 'BACKTEST'].includes(input.mode)) {
    fail('mode', 'must be PRODUCTION or BACKTEST');
  }
  validateString(input.window, 'window');
  validateString(input.windowNote, 'windowNote');

  if (!Array.isArray(input.rows) || input.rows.length === 0) {
    fail('rows', 'must contain at least one row');
  }
  input.rows.forEach((row, index) => {
    const field = `rows[${index}]`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      fail(field, 'must be an object');
    }
    for (const key of ['query', 'execs', 'mean', 'p95', 'total']) {
      if (!(key in row)) {
        fail(`${field}.${key}`, 'is required');
      }
    }
    validateString(row.query, `${field}.query`);
    validateControlCharacters(row.query, `${field}.query`, ['`']);
    if (input.rows.some((other, otherIndex) => otherIndex < index && other.query === row.query)) {
      fail(`${field}.query`, 'must be unique');
    }
    if (!Number.isInteger(row.execs) || row.execs <= 0) {
      fail(`${field}.execs`, 'must be a positive integer');
    }
    for (const key of ['mean', 'p95', 'total']) {
      validateFinite(row[key], `${field}.${key}`);
    }
  });

  for (const key of ['filed', 'alreadyTracked']) {
    if (!Array.isArray(input[key])) {
      fail(key, 'must be an array');
    }
    input[key].forEach((issue, index) => validateIssue(issue, `${key}[${index}]`));
  }

  if (input.mode === 'BACKTEST') {
    if (!('backtestProject' in input)) {
      fail('backtestProject', 'is required for BACKTEST');
    }
    validateString(input.backtestProject, 'backtestProject');
    if (input.backtestProject.trim() === '') {
      fail('backtestProject', 'must not be empty');
    }
  } else if ('backtestProject' in input) {
    fail('backtestProject', 'is only allowed for BACKTEST');
  }

  if (input.fix !== null) {
    if (!input.fix || typeof input.fix !== 'object' || Array.isArray(input.fix)) {
      fail('fix', 'must be an object or null');
    }
    for (const key of ['pr', 'url', 'summary', 'merged']) {
      if (!(key in input.fix)) {
        fail(`fix.${key}`, 'is required');
      }
    }
    validateString(input.fix.pr, 'fix.pr');
    validateUrl(input.fix.url, 'fix.url');
    validateString(input.fix.summary, 'fix.summary');
    if (typeof input.fix.merged !== 'boolean') {
      fail('fix.merged', 'must be a boolean');
    }
    if (!input.fix.summary.endsWith('.')) {
      fail('fix.summary', 'must end with a period');
    }
  }
}

function trimNumber(value, minimumDecimals = 2) {
  const [whole, fraction = ''] = value.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return `${whole}.${trimmed.padEnd(minimumDecimals, '0')}`;
}

function formatDuration(value, unit) {
  let formatted;
  if (value !== 0 && Math.abs(value) < 1) {
    const decimals = Math.min(20, Math.max(2, Math.ceil(-Math.log10(Math.abs(value))) + 2));
    const fixed = value.toFixed(decimals);
    formatted = Number(fixed) === 0 ? value.toExponential(6) : trimNumber(fixed);
  } else {
    formatted = value.toFixed(2);
  }
  if (Math.abs(value) >= 1000) {
    const [whole, fraction] = formatted.split('.');
    formatted = `${Number(whole).toLocaleString('en-US')}.${fraction}`;
  }
  return `${formatted} ${unit}`;
}

function formatCount(value) {
  return value.toLocaleString('en-US');
}

function formatTable(rows) {
  const values = rows.map((row, index) => [
    String(index + 1),
    row.query,
    formatCount(row.execs),
    formatDuration(row.mean, 'ms'),
    formatDuration(row.p95, 'ms'),
    formatDuration(row.total, 's'),
  ]);
  const headers = ['#', 'query', 'execs', 'mean', 'p95', 'total'];
  const widths = headers.map((header, index) => Math.max(
    header.length,
    ...values.map((row) => row[index].length),
  ));
  const align = (value, index) => index === 1
    ? value.padEnd(widths[index])
    : value.padStart(widths[index]);
  const lines = [
    headers.map(align).join('  '),
    ...values.map((row) => row.map(align).join('  ')),
  ];
  return ['```', ...lines, '```'].join('\n');
}

function rankingLine(rows) {
  const byTotal = rows.slice().sort((a, b) => b.total - a.total);
  const byMean = rows.slice().sort((a, b) => b.mean - a.mean);
  if (byTotal[0].query === byMean[0].query) {
    return 'The same query leads on total time and on mean per execution, so the two orderings agree.';
  }
  const rank = byTotal.findIndex((row) => row.query === byMean[0].query) + 1;
  return `A slowest-query-first view would have picked ${byMean[0].query} at ${formatDuration(byMean[0].mean, 'ms')}. It ranks ${rank} on total time.`;
}

function issueLines(heading, issues, project) {
  const lines = [];
  if (issues.length === 0) {
    lines.push(`*${heading}:* none`);
  } else {
    lines.push(`*${heading}:*`, ...issues.map((issue) => `• <${issue.url}|${issue.id}>: ${issue.title}`));
  }
  if (project) {
    lines.push(`(project: ${project})`);
  }
  return lines.join('\n');
}

function formatDigest(input) {
  validateInput(input);
  const rows = input.rows.slice().sort((a, b) => b.total - a.total);
  const header = `*Slow Query Patrol* · ${input.mode === 'BACKTEST' ? 'BACKTEST replay' : 'PRODUCTION daily run'} · ${input.window}`;
  const groups = [
    header,
    formatTable(rows),
    `*Ranking:* ${rankingLine(rows)}`,
    issueLines('Filed', input.filed, input.mode === 'BACKTEST' ? input.backtestProject : null),
  ];
  groups.push(issueLines('Already tracked', input.alreadyTracked));
  if (input.fix !== null) {
    groups.push(`*Fix:* <${input.fix.url}|${input.fix.pr}>: ${input.fix.summary} ${input.fix.merged ? 'Merged.' : 'Not merged.'}`);
  }
  groups.push(`*Window:* ${input.windowNote}`);
  return `${groups.join('\n\n')}\n`;
}

function main() {
  const file = process.argv[2];
  if (!file) {
    throw new Error('usage: node scripts/patrol-digest.js findings.json');
  }
  const input = JSON.parse(fs.readFileSync(file, 'utf8'));
  process.stdout.write(formatDigest(input));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { formatDigest, validateInput };
