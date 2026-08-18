#!/usr/bin/env node

const http = require('http');
const https = require('https');

const DEFAULT_INVARIANTS = ['totalAvailable', 'innerQueryCount'];
const DEFAULT_PORT = 3110;

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !key.startsWith('--') || value === undefined) {
      throw new Error('usage: node scripts/patrol-compare-page.js --before URL --after URL --path PATH [--port N] [--invariants a,b]');
    }
    options[key.slice(2)] = value;
  }
  for (const key of ['before', 'after', 'path']) {
    if (!options[key]) {
      throw new Error(`missing --${key}`);
    }
  }
  if (!/^\/.+/.test(options.path) || options.path.startsWith('//')) {
    throw new Error('--path must start with / and must not be protocol-relative');
  }
  for (const key of ['before', 'after']) {
    if (new URL(options[key]).pathname !== '/') {
      throw new Error(`--${key} URL pathname must be "/" because --path is resolved against the origin`);
    }
  }
  if (options.port !== undefined && !/^[1-9]\d*$/.test(options.port)) {
    throw new Error('--port must be a positive integer');
  }
  options.port = options.port ? Number(options.port) : DEFAULT_PORT;
  options.invariants = options.invariants
    ? options.invariants.split(',').map((name) => name.trim()).filter(Boolean)
    : DEFAULT_INVARIANTS;
  if (options.invariants.length === 0) {
    throw new Error('--invariants must name at least one field');
  }
  return options;
}

function fetchJson(baseUrl, path) {
  const url = new URL(path, `${baseUrl.replace(/\/$/, '')}/`);
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`${url.href}: response body is not JSON`));
        }
      });
    });
    request.on('error', (error) => reject(new Error(`${url.href}: ${error.message}`)));
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatMs(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${value.toFixed(2)} ms`
    : 'not reported';
}

function speedup(before, after) {
  const from = before.totalDurationMs;
  const to = after.totalDurationMs;
  if (![from, to].every((value) => typeof value === 'number' && Number.isFinite(value)) || to <= 0) {
    return '';
  }
  return ` On this reload the fixed code returned ${(from / to).toFixed(1)} times faster.`;
}

function invariantRows(invariants, before, after) {
  return invariants.map((field) => {
    const beforeValue = JSON.stringify(before[field]);
    const afterValue = JSON.stringify(after[field]);
    const same = beforeValue === afterValue;
    return `<tr class="${same ? 'same' : 'differs'}">
      <td class="field">${escapeHtml(field)}</td>
      <td class="value">${escapeHtml(beforeValue)}</td>
      <td class="value">${escapeHtml(afterValue)}</td>
      <td class="verdict">${same ? 'identical' : 'DIFFERS'}</td>
    </tr>`;
  }).join('\n');
}

function renderPage(options, before, after) {
  const invariants = invariantRows(options.invariants, before, after);
  const allSame = options.invariants.every(
    (field) => JSON.stringify(before[field]) === JSON.stringify(after[field]),
  );
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Pre-fix and fixed comparison</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 28px 32px 40px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    color: #111;
    background: #fff;
  }
  h1 { font-size: 19px; font-weight: 650; margin: 0 0 4px; }
  .sub { font-size: 13px; color: #555; margin: 0 0 22px; }
  .sub code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .panes { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  .pane { border: 1px solid #d8d8d8; border-radius: 8px; overflow: hidden; }
  .pane header { padding: 12px 16px; border-bottom: 1px solid #d8d8d8; }
  .pane.before header { background: #f3f3f3; }
  .pane.after header { background: #eef6f0; }
  .label { font-size: 12px; letter-spacing: 0.10em; text-transform: uppercase; font-weight: 700; }
  .origin { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #555; margin-top: 3px; }
  .duration { font-size: 30px; font-weight: 650; font-variant-numeric: tabular-nums; margin: 16px 16px 0; }
  .duration-label { font-size: 12px; color: #555; margin: 2px 16px 14px; }
  pre {
    margin: 0; padding: 14px 16px; border-top: 1px solid #ececec; background: #fafafa;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; line-height: 1.55;
    white-space: pre; overflow-x: auto;
  }
  table { width: 100%; border-collapse: collapse; margin-top: 24px; font-size: 13px; }
  caption { text-align: left; font-size: 13px; font-weight: 650; padding-bottom: 8px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #ececec; }
  th { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: #555; font-weight: 600; }
  .field, .value { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .verdict { font-weight: 650; }
  tr.same .verdict { color: #1c6b3c; }
  tr.differs .verdict { color: #a11212; }
  .footer { margin-top: 18px; font-size: 13px; color: #333; }
  .stamp { margin-top: 6px; font-size: 12px; color: #666; font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
  <h1>Same job, same output, two code paths</h1>
  <p class="sub">Both panes are <code>${escapeHtml(options.path)}</code>, requested fresh on every reload. Reload to see the durations move and the fields below hold still.</p>
  <div class="panes">
    <section class="pane before">
      <header>
        <div class="label">Pre-fix code</div>
        <div class="origin">${escapeHtml(new URL(options.before).origin)}</div>
      </header>
      <div class="duration">${escapeHtml(formatMs(before.totalDurationMs))}</div>
      <div class="duration-label">reported by the job</div>
      <pre>${escapeHtml(JSON.stringify(before, null, 2))}</pre>
    </section>
    <section class="pane after">
      <header>
        <div class="label">Fixed code</div>
        <div class="origin">${escapeHtml(new URL(options.after).origin)}</div>
      </header>
      <div class="duration">${escapeHtml(formatMs(after.totalDurationMs))}</div>
      <div class="duration-label">reported by the job</div>
      <pre>${escapeHtml(JSON.stringify(after, null, 2))}</pre>
    </section>
  </div>
  <table>
    <caption>Fields that must not move</caption>
    <thead>
      <tr><th>field</th><th>pre-fix</th><th>fixed</th><th>verdict</th></tr>
    </thead>
    <tbody>
${invariants}
    </tbody>
  </table>
  <p class="footer">${allSame
    ? 'Every field above holds its value across the two code paths.'
    : 'At least one field above changed, so the fix does not preserve the job output.'}${speedup(before, after)}</p>
  <p class="stamp">Rendered ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC</p>
</body>
</html>`;
}

function startServer(options) {
  const server = http.createServer(async (req, res) => {
    if (req.url !== '/' && req.url !== '/index.html') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found\n');
      return;
    }
    try {
      const [before, after] = await Promise.all([
        fetchJson(options.before, options.path),
        fetchJson(options.after, options.path),
      ]);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(renderPage(options, before, after));
    } catch (error) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`${error.message}\n`);
    }
  });
  return new Promise((resolve) => {
    server.listen(options.port, '127.0.0.1', () => resolve(server));
  });
}

if (require.main === module) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  startServer(options).then(() => {
    process.stdout.write(`comparison page on http://127.0.0.1:${options.port}\n`);
  });
}

module.exports = { parseArgs, renderPage, startServer };
