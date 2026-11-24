const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const script = fs.readFileSync(path.join(__dirname, '../scripts/deploy-ec2.sh'), 'utf8');
const helpers = script.slice(script.indexOf('extra_mem_ok() {'), script.indexOf('if avature_sync'));

function run(body, { availMb = 2048, running = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-extra-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/bash\necho "docker $*" >>"${dir}/calls"\ncase " $* " in *" ps -q "*) printf '%s' "$RUNNING" ;; esac\nexit 0\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(dir, 'src/.git'), { recursive: true });
  const res = spawnSync('bash', ['-c', `set -euo pipefail
log() { echo "LOG $*"; }
avail_mem_mb() { echo ${availMb}; }
EXTRA_BUILD_MIN_MEM_MB=1024 EXTRA_BUILD_TIMEOUT=5 AV_ERR="${dir}/err" SRC="${dir}/src"
${helpers}
${body}`], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNING: running }, encoding: 'utf8' });
  const calls = fs.existsSync(path.join(dir, 'calls')) ? fs.readFileSync(path.join(dir, 'calls'), 'utf8') : '';
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...res, calls };
}

test('extra stack builds are skipped when RAM + swap is below EXTRA_BUILD_MIN_MEM_MB', () => {
  const res = run('extra_mem_ok f2ec3d90 && echo BUILD || echo SKIP', { availMb: 700 });
  expect(res.stdout).toContain('SKIP');
  expect(res.stdout).toContain('f2ec3d90 build skipped, only 700MB available');
  expect(run('extra_mem_ok f2ec3d90 && echo BUILD', { availMb: 1500 }).stdout).toContain('BUILD');
});

test('extra builds run through docker compose under a timeout', () => {
  const res = run('extra_build --profile f2ec3d90 build --pull f2ec3d90');
  expect(res.status).toBe(0);
  expect(res.calls).toContain('docker compose --profile f2ec3d90 build --pull f2ec3d90');
  expect(script).toMatch(/extra_build\(\) \{ timeout -k 30 "\$EXTRA_BUILD_TIMEOUT" docker compose/);
});

test('an unchanged extra stack that is already running is not rebuilt', () => {
  const mark = 'echo abc123 >"$(extra_built_marker "$SRC")"; ';
  expect(run(`${mark}extra_current f2ec3d90 f2ec3d90 "$SRC" abc123 && echo CURRENT`, { running: 'c1' }).stdout).toContain('CURRENT');
  expect(run(`${mark}extra_current f2ec3d90 f2ec3d90 "$SRC" def456 || echo STALE`, { running: 'c1' }).stdout).toContain('STALE');
  expect(run(`${mark}extra_current f2ec3d90 f2ec3d90 "$SRC" abc123 || echo STOPPED`).stdout).toContain('STOPPED');
  expect(run('extra_current f2ec3d90 f2ec3d90 "$SRC" "" || echo NOSHA', { running: 'c1' }).stdout).toContain('NOSHA');
});

test('every best-effort extra stack build is memory-gated and time-limited', () => {
  const extras = script.slice(script.indexOf('# ── 5b. f2ec3d90'), script.indexOf('# ── 6. reconcile'));
  expect(extras).not.toMatch(/\bcompose (--profile \S+ )?build\b/);
  for (const svc of ['f2ec3d90', 'resort-inventory', 'b8d844e5-pos', 'b8d844e5-inventory', 'b8d844e5-storefront']) {
    expect(extras).toContain(`extra_mem_ok ${svc}`);
  }
});
