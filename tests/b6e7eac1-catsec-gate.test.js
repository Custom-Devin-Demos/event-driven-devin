/* global describe, expect, test */

/**
 * CAT-SEC secure-coding gate for the rental-return integration demo (b6e7eac1).
 * Fast regex checks over the demo's own files; the standard is docs/b6e7eac1/CAT-SEC-secure-coding.md.
 * A line can be whitelisted with a trailing `catsec:allow <rule>` comment.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = [
  'app/services/verticals/b6e7eac1.js',
  'app/services/verticals/b6e7eac1-seed.js',
  'app/routes/verticals/b6e7eac1.js',
  'app/public/verticals/b6e7eac1.html',
  'docs/b6e7eac1/alert-sample.json',
];

const RULES = [
  { id: 'CAT-SEC-01', desc: 'Hard-coded secret, key or connection string', re: /(password|passwd|secret|apikey|api_key|clientsecret|connectionstring|sharedaccesskey)[A-Za-z_]*["']?\s*[:=]\s*["'](?![A-Z0-9_]+["'])[^"'$`{][^"']{7,}["']/i },
  { id: 'CAT-SEC-02', desc: 'Plain-text HTTP endpoint (TLS required outside localhost)', re: /["'`]http:\/\/(?!localhost|127\.0\.0\.1|www\.w3\.org|json\.schemastore\.org)[^"'`]+/ },
  { id: 'CAT-SEC-03', desc: 'OData $filter built by string concatenation or interpolation', re: /\$filter=[^;]*["'`]\s*\+\s*[A-Za-z_]|\$filter=[^;]*\$\{/ },
  { id: 'CAT-SEC-04', desc: 'Machine serial number written to a log', re: /logger\.(info|warn|error|debug)\([^;]*[Ss]erial/ },
  { id: 'CAT-SEC-05', desc: 'D365 query without a legal-entity (dataAreaId) scope', re: /cross-company=true/ },
];

describe('CAT-SEC gate (b6e7eac1)', () => {
  const started = Date.now();
  const findings = [];
  for (const file of FILES) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/catsec:allow/.test(line)) return;
      for (const rule of RULES) {
        if (rule.re.test(line)) findings.push(`${rule.id} ${file}:${i + 1} — ${rule.desc}`);
      }
    });
  }
  const elapsedMs = Date.now() - started;

  test('no CAT-SEC findings in the demo files', () => {
    expect(findings).toEqual([]);
  });

  test('the gate stays sub-second', () => {
    expect(elapsedMs).toBeLessThan(1000);
  });

  test('the gate catches what it is meant to catch', () => {
    const bad = [
      ['CAT-SEC-01', 'const connectionString = "Endpoint=sb://x;SharedAccessKey=abcdefghij";'],
      ['CAT-SEC-02', "fetch('http://erp.example.com/data')"],
      ['CAT-SEC-03', 'const q = "$filter=ContractId eq \'" + id + "\'";'],
      ['CAT-SEC-04', "logger.info('return', { serialNumber: evt.serialNumber })"],
      ['CAT-SEC-05', 'url + "?cross-company=true"'],
    ];
    for (const [id, line] of bad) {
      expect(RULES.find((r) => r.id === id).re.test(line)).toBe(true);
    }
  });
});
