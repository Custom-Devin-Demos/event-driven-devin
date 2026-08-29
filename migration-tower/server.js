/**
 * Migration Control Tower
 *
 * Parity dashboard for the Ab Initio -> dbt migration demo. Runs the
 * legacy runner + dbt build + reconcile pipeline (via
 * modern-data-platform/control_tower/run_parity.py) for a chosen graph and
 * input environment (sample | staging), renders the parity verdict, and on
 * failure can alert Slack and trigger a Devin remediation session.
 *
 * Runs as its own container (needs python/dbt/duckdb, unlike checkout-api)
 * and is proxied by nginx at /migration.
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');
const express = require('express');
const axios = require('axios');

const app = express();
// nginx is the only ingress; trust exactly one proxy hop so req.ip is the
// real client address from X-Forwarded-For and cannot be forged by clients
app.set('trust proxy', 1);
app.use(express.json());

const PORT = process.env.PORT || 3200;
const LEGACY_REPO = process.env.LEGACY_REPO_DIR || '/repos/abinitio-retail-dwh';
const MDP_REPO = process.env.MDP_REPO_DIR || '/repos/modern-data-platform';
const RUNS_FILE = process.env.MIGRATION_RUNS_FILE || '/data/migration-runs.json';
const ACCESS_CODE = process.env.MIGRATION_ACCESS_CODE || '';
const LEGACY_REPO_URL = 'https://github.com/COG-GTM/abinitio-retail-dwh';
const MDP_REPO_URL = 'https://github.com/COG-GTM/modern-data-platform';

const GRAPHS = ['txn_aggregation', 'fx_normalization'];
const ENVS = ['sample', 'staging'];

// ── run store ────────────────────────────────────────────────────────────
let runs = [];
try {
  runs = JSON.parse(fs.readFileSync(RUNS_FILE, 'utf8'));
} catch (e) { /* first boot */ }

// the execution queue is process-local, so any non-terminal run loaded from
// disk was interrupted by a restart and will never finish
for (const r of runs) {
  if (r.status === 'queued' || r.status === 'running') {
    r.status = 'error';
    r.overall = 'error';
    r.error = 'interrupted by server restart';
    r.finishedAt = r.finishedAt || new Date().toISOString();
  }
}

const MAX_RUNS = 100;
// parity runs are serialized and take ~1-2 min each, so a deep backlog is
// never useful; bounding it also keeps the active set well under MAX_RUNS
const MAX_ACTIVE_RUNS = 20;

// keep at most MAX_RUNS records in memory, evicting oldest terminal runs first;
// queued/running runs are never evicted so their results always land
function pruneRuns() {
  let excess = runs.length - MAX_RUNS;
  if (excess <= 0) return;
  runs = runs.filter((r) => {
    if (excess > 0 && r.status !== 'queued' && r.status !== 'running') {
      excess -= 1;
      return false;
    }
    return true;
  });
}

function persistRuns() {
  pruneRuns();
  try {
    fs.mkdirSync(path.dirname(RUNS_FILE), { recursive: true });
    fs.writeFileSync(RUNS_FILE, JSON.stringify(runs, null, 2));
  } catch (e) {
    console.error('failed to persist runs:', e.message);
  }
}

persistRuns();

// ── serialized pipeline execution (shared DuckDB file) ───────────────────
let queue = Promise.resolve();

function executeParity(run) {
  const outFile = path.join('/tmp', `parity_${run.id}.json`);
  return new Promise((resolve) => {
    const proc = spawn('python3', [
      path.join(MDP_REPO, 'control_tower', 'run_parity.py'),
      '--graph', run.graph,
      '--env', run.env,
      '--legacy-repo', LEGACY_REPO,
      '--out', outFile,
    ], { cwd: MDP_REPO });

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', (code) => {
      try {
        run.result = JSON.parse(fs.readFileSync(outFile, 'utf8'));
        run.status = 'done';
        run.overall = run.result.overall;
      } catch (e) {
        run.status = 'error';
        run.overall = 'error';
        run.error = `runner exit ${code}: ${stderr.slice(-2000)}`;
      }
      try { fs.rmSync(outFile, { force: true }); } catch (e) { /* best effort */ }
      run.finishedAt = new Date().toISOString();
      persistRuns();
      resolve(run);
    });
  });
}

// ── Slack + Devin dispatch ───────────────────────────────────────────────
function mismatchSummary(result) {
  const lines = [];
  for (const t of result.tables || []) {
    if (t.status === 'fail') {
      lines.push(`- ${t.table}: ${t.matched_rows}/${t.legacy_rows} rows match (${t.parity_pct}% parity)`);
      for (const m of t.mismatched_columns || []) {
        const s = (m.samples || [])[0];
        lines.push(`  - column ${m.column}: ${m.count} mismatched rows` +
          (s ? ` (e.g. key ${JSON.stringify(s.key)}: legacy=${s.legacy} target=${s.target})` : ''));
      }
    } else if (t.status === 'not_migrated') {
      lines.push(`- ${t.table}: not migrated yet`);
    }
  }
  return lines.join('\n');
}

function buildDevinPrompt(run) {
  const playbook = process.env.DEVIN_PLAYBOOK_ID_MIGRATION
    ? `Follow @playbook:${process.env.DEVIN_PLAYBOOK_ID_MIGRATION}\n\n` : '';
  const towerUrl = process.env.MIGRATION_TOWER_URL || 'https://devindemos.com/migration';
  return `${playbook}Parity regression detected by the Migration Control Tower (${towerUrl}).

Graph: ${run.graph}
Environment: ${run.env} (input dir: ${run.result.input_dir})
Overall: ${run.overall}

Mismatch details:
${mismatchSummary(run.result)}

The legacy estate is ${LEGACY_REPO_URL} (the legacy runner defines correct behavior; for the staging feed image run scripts/run_graph.py ${run.graph} --indir data/staging_in). The migrated dbt project is ${MDP_REPO_URL}. Reproduce the failure with control_tower/run_parity.py --graph ${run.graph} --env ${run.env} --legacy-repo <legacy checkout>, isolate the mismatched rows, determine whether the defect is in the migrated model SQL or a shared transpiler rule, fix it, add a regression test, and rerun until parity is 100%. Open a PR that includes the initial failing parity evidence and the final passing report.`;
}

async function dispatchToDevin(run) {
  const dispatch = { requestedAt: new Date().toISOString() };
  run.dispatch = dispatch;

  // Slack alert (best effort)
  const slackToken = process.env.SLACK_BOT_TOKEN || '';
  const slackChannel = process.env.SLACK_MIGRATION_CHANNEL_ID || process.env.SLACK_CHANNEL_ID || '';
  if (slackToken && slackChannel) {
    try {
      const resp = await axios.post('https://slack.com/api/chat.postMessage', {
        channel: slackChannel,
        text: `:rotating_light: Parity regression — ${run.graph} on ${run.env} data\n${mismatchSummary(run.result)}`,
      }, {
        headers: { Authorization: `Bearer ${slackToken}`, 'Content-Type': 'application/json' },
        timeout: 10000,
      });
      dispatch.slack = resp.data.ok ? 'sent' : `error: ${resp.data.error}`;
    } catch (e) {
      dispatch.slack = `error: ${e.message}`;
    }
  } else {
    dispatch.slack = 'not_configured';
  }

  // Devin session (v3 org API, same pattern as app/services/devin-api.js)
  const serviceKey = process.env.DEVIN_SERVICE_KEY_MIGRATION
    || process.env.DEVIN_SERVICE_KEY || process.env.DEVIN_API_KEY || '';
  const orgId = process.env.DEVIN_ORG_ID_MIGRATION || process.env.DEVIN_ORG_ID || '';
  if (!serviceKey || !orgId) {
    dispatch.devin = 'not_configured';
    return dispatch;
  }
  try {
    const body = { prompt: buildDevinPrompt(run), title: `Fix parity regression: ${run.graph} (${run.env})` };
    if (process.env.DEVIN_USER_ID) body.create_as_user_id = process.env.DEVIN_USER_ID;
    const resp = await axios.post(
      `https://api.devin.ai/v3/organizations/${orgId}/sessions`,
      body,
      { headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' }, timeout: 15000 },
    );
    dispatch.devin = 'created';
    dispatch.sessionId = resp.data.session_id;
    dispatch.sessionUrl = resp.data.url || `https://app.devin.ai/sessions/${resp.data.session_id}`;
  } catch (e) {
    dispatch.devin = `error: ${e.response?.status || ''} ${e.message}`;
  }
  return dispatch;
}

// ── API ──────────────────────────────────────────────────────────────────
const router = express.Router();

router.get('/api/config', (req, res) => {
  res.json({
    graphs: GRAPHS,
    envs: ENVS,
    accessCodeRequired: Boolean(ACCESS_CODE),
    autoDispatch: process.env.MIGRATION_AUTO_DISPATCH === 'true',
    repos: { legacy: LEGACY_REPO_URL, target: MDP_REPO_URL },
  });
});

// brute-force protection for the short access code: after too many failed
// attempts from one client IP, lock that IP out for a cooldown period
const CODE_ATTEMPT_LIMIT = 10;
const CODE_LOCKOUT_MS = 15 * 60 * 1000;
// global budget across all sources so rotating addresses cannot buy
// unlimited guesses against the short code
const CODE_GLOBAL_LIMIT = 100;
const codeAttempts = new Map(); // ip -> { count, lockedUntil }
let globalFailures = { count: 0, windowStart: 0 };

function checkCode(req, code) {
  if (!ACCESS_CODE) return { ok: true };
  const ip = String(req.ip || 'unknown');
  const entry = codeAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  const now = Date.now();
  if (now - globalFailures.windowStart > CODE_LOCKOUT_MS) {
    globalFailures = { count: 0, windowStart: now };
  }
  if (entry.lockedUntil > now || globalFailures.count >= CODE_GLOBAL_LIMIT) {
    return { ok: false, locked: true };
  }
  if (String(code || '') === ACCESS_CODE) {
    codeAttempts.delete(ip);
    return { ok: true };
  }
  globalFailures.count += 1;
  entry.count += 1;
  if (entry.count >= CODE_ATTEMPT_LIMIT) {
    entry.lockedUntil = now + CODE_LOCKOUT_MS;
    entry.count = 0;
  }
  codeAttempts.set(ip, entry);
  return { ok: false, locked: entry.lockedUntil > now };
}

router.post('/api/verify-code', (req, res) => {
  const check = checkCode(req, req.body?.code);
  if (check.locked) return res.status(429).json({ ok: false, error: 'too many attempts, try again later' });
  res.json({ ok: check.ok });
});

// server-side gate for mutating endpoints: the browser sends the code in
// an X-Access-Code header once the user has passed the gate
function requireAccessCode(req, res, next) {
  const check = checkCode(req, req.get('x-access-code'));
  if (check.ok) return next();
  if (check.locked) return res.status(429).json({ error: 'too many attempts, try again later' });
  return res.status(403).json({ error: 'invalid access code' });
}

router.get('/api/runs', (req, res) => {
  res.json(runs.slice(-30).reverse());
});

router.get('/api/runs/:id', (req, res) => {
  const run = runs.find((r) => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  res.json(run);
});

router.post('/api/runs', requireAccessCode, (req, res) => {
  const { graph, env } = req.body || {};
  if (!GRAPHS.includes(graph) || !ENVS.includes(env)) {
    return res.status(400).json({ error: `graph must be one of ${GRAPHS}, env one of ${ENVS}` });
  }
  const active = runs.filter((r) => r.status === 'queued' || r.status === 'running').length;
  if (active >= MAX_ACTIVE_RUNS) {
    return res.status(429).json({ error: 'too many runs in progress, try again shortly' });
  }
  const run = {
    id: crypto.randomBytes(6).toString('hex'),
    graph,
    env,
    status: 'queued',
    startedAt: new Date().toISOString(),
  };
  runs.push(run);
  persistRuns();
  queue = queue.then(async () => {
    run.status = 'running';
    await executeParity(run);
    if (run.overall === 'fail' && process.env.MIGRATION_AUTO_DISPATCH === 'true') {
      await dispatchToDevin(run);
      persistRuns();
    }
  }).catch((e) => {
    console.error('parity run failed:', e);
    run.status = 'error';
    run.overall = 'error';
    run.error = e.message;
    run.finishedAt = new Date().toISOString();
    persistRuns();
  });
  res.status(202).json(run);
});

router.post('/api/runs/:id/dispatch', requireAccessCode, async (req, res) => {
  const run = runs.find((r) => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  if (run.status !== 'done' || run.overall !== 'fail') {
    return res.status(400).json({ error: 'dispatch is only available for completed failing runs' });
  }
  if (run.dispatch && run.dispatch.devin === 'created') {
    return res.json(run.dispatch);
  }
  const dispatch = await dispatchToDevin(run);
  persistRuns();
  res.json(dispatch);
});

router.get('/health', (req, res) => res.json({ ok: true }));

router.use(express.static(path.join(__dirname, 'public')));

// mounted at /migration so nginx can proxy without rewriting; the UI uses
// relative API paths, so /migration must redirect to /migration/
app.get('/migration', (req, res) => res.redirect(301, '/migration/'));
app.use('/migration', router);
app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`migration-tower listening on ${PORT}`);
});
