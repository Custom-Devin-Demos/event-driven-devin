#!/usr/bin/env node
/* global fetch */

/**
 * Demo controls for the Ralph Lauren checkout incident (slug f63013c0).
 *
 *   node scripts/f63013c0-demo.js <reset|start|stop|flip|unflip|status>
 *                                 [--base-url http://localhost:3000]
 *                                 [--flip-after 120] [--rate 9] [--retry-pct 0.7]
 */

function parseArgs(argv) {
  const args = { command: argv[0], baseUrl: 'http://localhost:3000' };
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--base-url') args.baseUrl = argv[++i];
    else if (argv[i] === '--flip-after') args.flipAfterSeconds = Number(argv[++i]);
    else if (argv[i] === '--rate') args.rate = Number(argv[++i]);
    else if (argv[i] === '--retry-pct') args.retryPct = Number(argv[++i]);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = args.baseUrl.replace(/\/$/, '');
  const commands = ['reset', 'start', 'stop', 'flip', 'unflip', 'status'];
  if (!commands.includes(args.command)) {
    console.error(`Usage: node scripts/f63013c0-demo.js <${commands.join('|')}> [--base-url] [--flip-after] [--rate] [--retry-pct]`);
    process.exit(1);
  }

  if (args.command === 'status') {
    const res = await fetch(`${base}/api/f63013c0/metrics`);
    console.log(JSON.stringify(await res.json(), null, 2));
    return;
  }

  const body = {};
  if (args.command === 'start') {
    if (args.flipAfterSeconds !== undefined) body.flipAfterSeconds = args.flipAfterSeconds;
    if (args.rate !== undefined) body.rate = args.rate;
    if (args.retryPct !== undefined) body.retryPct = args.retryPct;
  }

  const res = await fetch(`${base}/api/f63013c0/demo/${args.command}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) {
    console.error(`demo/${args.command} -> ${res.status}: ${JSON.stringify(json)}`);
    process.exit(1);
  }
  console.log(JSON.stringify(json, null, 2));
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
