'use strict';

// Stamp the standing automations-service repo: build a fresh git history of
// ~50 mundane, backdated commits (relative to today) whose final tree is
// exactly standing-service/template/, then optionally force-push it to the
// standing repo. Re-run quarterly so the history never goes stale.
//
// Usage:
//   node generate.js <output-dir> [--push <remote-url>]
//
// History shape (spec §3):
//   - ~6 months of plausible commits from several authors
//   - early history carries the AUTOMATIONS_QUEUE_INGESTION env flag,
//     removed around T-11d with a PR reference in the message
//   - a "previous incident" fix lands around T-5d
//   - release/1.14 is cut before a late mainline refactor
//   - the working tree at HEAD is byte-identical to template/

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TEMPLATE = path.join(__dirname, '..', 'template');
const EXCLUDE = new Set(['node_modules', '.git', 'package-lock.json', '.env']);

const AUTHORS = [
  { name: 'Sam Whitfield', email: 'sam.whitfield@example.com' },
  { name: 'Dana Okafor', email: 'dana.okafor@example.com' },
  { name: 'Leo Martins', email: 'leo.martins@example.com' },
  { name: 'Ingrid Halvorsen', email: 'ingrid.halvorsen@example.com' },
];

function daysAgo(n, hour = 10, minute = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(hour, minute + Math.floor(Math.random() * 50), 0, 0);
  return d.toISOString();
}

function listTemplateFiles(dir = TEMPLATE, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name)) continue;
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...listTemplateFiles(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

function copyFromTemplate(repo, files) {
  for (const rel of files) {
    const dest = path.join(repo, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(TEMPLATE, rel), dest);
  }
}

// The legacy flags module that lives only in seeded history: the old
// AUTOMATIONS_QUEUE_INGESTION env flag predates the DB-backed flags.
const LEGACY_FLAGS = `'use strict';

// AUTOMATIONS_QUEUE_INGESTION: temporary env kill switch for the queue
// ingestion rollout. Remove once the DB-backed flags land.
function isQueueIngestionEnabled() {
  return process.env.AUTOMATIONS_QUEUE_INGESTION !== 'false';
}

module.exports = { isQueueIngestionEnabled };
`;

function main() {
  const [outDir, pushFlag, remoteUrl] = process.argv.slice(2);
  if (!outDir) {
    process.stderr.write('usage: generate.js <output-dir> [--push <remote-url>]\n');
    process.exit(1);
  }
  const repo = path.resolve(outDir);
  fs.mkdirSync(repo, { recursive: true });
  if (fs.readdirSync(repo).length > 0) {
    process.stderr.write(`${repo} is not empty\n`);
    process.exit(1);
  }

  let authorIdx = 0;
  function git(args, env = {}) {
    return execFileSync('git', args, { cwd: repo, env: { ...process.env, ...env } }).toString();
  }
  let lastCommitMs = 0;
  function commit(message, atDaysAgo) {
    const author = AUTHORS[authorIdx % AUTHORS.length];
    authorIdx += 1;
    let when = new Date(daysAgo(atDaysAgo, 9 + (authorIdx % 8)));
    // Keep author dates strictly increasing even within the same day.
    if (when.getTime() <= lastCommitMs) {
      when = new Date(lastCommitMs + (20 + Math.floor(Math.random() * 70)) * 60 * 1000);
    }
    lastCommitMs = when.getTime();
    const date = when.toISOString();
    git(['add', '-A']);
    git(['commit', '--allow-empty-message', '-m', message], {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    });
  }
  function write(rel, content) {
    const dest = path.join(repo, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }

  git(['init', '-b', 'main']);

  // --- ~T-180d .. T-30d: scaffold and steady mundane work ---------------
  const steps = [
    [178, ['package.json', '.gitignore', 'README.md'], 'feature: scaffold automations-service'],
    [172, ['src/telemetry.js', 'src/db.js'], 'feature: telemetry and db pool'],
    [165, ['migrations/001-automation-triggers.sql'], 'feature: automation_triggers schema'],
    [158, ['src/queue.js'], 'feature: SQS queue wrapper with local fallback'],
    [151, ['src/matcher.js', 'docs/matcher-design.md'], 'feature: recurring matcher with cursor semantics'],
    [140, ['migrations/002-automation-queued-events.sql', 'migrations/003-automation-event-data.sql'], 'feature: queued events and event data tables'],
    [132, ['src/storage/provider-a.js', 'src/storage/index.js'], 'feature: org storage provider selection'],
    [120, ['src/indirect-data.js'], 'feature: IndirectData blob writes'],
    [110, ['src/ingest.js'], 'feature: ingest worker'],
    [98, ['migrations/004-support-tables.sql', 'scripts/migrate.js'], 'feature: support tables and migration runner'],
    [88, ['src/executor.js'], 'feature: executor with warehouse dim_sessions writes'],
    [76, ['src/storage/provider-b.js'], 'feature: provider B storage client'],
    [66, ['admin/server.js', 'admin/vpc.js'], 'feature: internal admin API and vpc provisioning'],
    [55, ['scripts/provision-customer.js'], 'feature: customer provisioning script'],
    [47, ['docs/dlq-runbook.md'], 'feature: DLQ runbook'],
    [40, ['tests/service.test.js'], 'feature: service test suite'],
    [33, ['src/runtime-stats.js', 'admin/demo.js', 'src/index.js', '.env.example'], 'feature: ops arm/disarm endpoints and service entrypoint'],
  ];
  // Steady mundane cadence: a changelog that grows across the whole period
  // and is retired near the end (so it never appears in the final tree).
  const changelogEntries = [];
  const patchNotes = [
    'bump pg to pick up connection teardown fix',
    'clarify visibility timeout in queue wrapper comment',
    'tighten matcher window logging',
    'document DATABASE_URL pooling expectations',
    'add index note for pending queue scans',
    'rename internal tick helpers for clarity',
    'quiet noisy dd-trace startup log',
    'document provider config JSON shape',
    'note release branch policy',
    'align jest config with repo defaults',
    'update runbook escalation path',
    'drop unused dev dependency',
    'clarify cursor coalescing example',
    'document admin token rotation',
    'fix typo in matcher design doc',
    'record warehouse pooler URI format',
    'note DLQ purge is at-most-once',
    'trim stale TODOs',
    'document heartbeat endpoint',
    'add provisioning example to README',
    'clarify executor drain batch size',
    'note statsd tag hygiene',
    'document migration ordering',
    'update on-call rotation pointer',
    'clarify local queue fallback semantics',
  ];
  // Merge scaffold steps and changelog notes into one chronological timeline
  // so commit order matches author dates.
  const timeline = [];
  for (const [days, files, message] of steps) {
    timeline.push({ day: days, run: () => copyFromTemplate(repo, files), message });
  }
  timeline.push({
    day: 176,
    run: () => write('src/flags.js', LEGACY_FLAGS),
    message: 'feature: AUTOMATIONS_QUEUE_INGESTION rollout flag',
  });
  patchNotes.forEach((note, i) => {
    timeline.push({
      day: 170 - i * 6, // ~T-170d .. ~T-26d
      run: () => {
        changelogEntries.push(`- ${note}`);
        write('docs/CHANGELOG.md', `# Changelog\n\n${changelogEntries.join('\n')}\n`);
      },
      message: `feature: ${note}`,
    });
  });
  timeline.sort((a, b) => b.day - a.day);
  for (const entry of timeline) {
    entry.run();
    commit(entry.message, entry.day);
  }

  // Mundane touch-ups between T-30d and T-13d.
  const readme = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
  write('README.md', `${readme}\n<!-- ops contact: #eng-automations -->\n`);
  commit('feature: note ops channel in README', 24);
  write('README.md', readme);
  commit('feature: move ops contact to internal wiki', 21);

  fs.rmSync(path.join(repo, 'docs/CHANGELOG.md'));
  commit('feature: retire changelog in favor of release notes', 14);

  // T-12d: cut the release branch before the flag refactor lands on main.
  git(['branch', 'release/1.14']);

  // T-11d: DB-backed flags replace the env flag (PR-referenced removal).
  copyFromTemplate(repo, ['src/flags.js']);
  commit('feature: DB-backed feature flags; drop AUTOMATIONS_QUEUE_INGESTION (#241)', 11);

  // T-5d: previous-incident fix.
  copyFromTemplate(repo, ['scripts/cherry-pick-to-release.sh']);
  commit('bug: harden release cherry-pick after INC-1093 backport miss', 5);

  // Final sync: guarantee HEAD tree == template.
  copyFromTemplate(repo, listTemplateFiles());
  try {
    git(['add', '-A']);
    git(['diff', '--cached', '--quiet']);
  } catch {
    commit('feature: align executor telemetry tags with dashboard queries', 2);
  }

  // Verify byte-identical tree.
  for (const rel of listTemplateFiles()) {
    const a = fs.readFileSync(path.join(TEMPLATE, rel));
    const b = fs.readFileSync(path.join(repo, rel));
    if (!a.equals(b)) throw new Error(`stamped tree differs from template: ${rel}`);
  }

  const log = git(['log', '--oneline']).trim().split('\n');
  process.stdout.write(`stamped ${repo}: ${log.length} commits on main + release/1.14\n`);

  if (pushFlag === '--push') {
    if (!remoteUrl) throw new Error('--push requires a remote URL');
    git(['remote', 'add', 'origin', remoteUrl]);
    git(['push', '--force', 'origin', 'main', 'release/1.14']);
    process.stdout.write(`pushed to ${remoteUrl}\n`);
  }
}

main();
