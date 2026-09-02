const axios = require('axios');
const logger = require('../../telemetry/logger');

/**
 * Incident Lab subject-repo sweep: the investigator's fix artifacts on the
 * subject repo (fix branches and their open PRs) are demo residue — the next
 * run's investigator would find a ready-made fix and skip the investigation.
 * The sweep closes open PRs whose head is a `devin/` branch on the subject
 * repo itself and deletes `devin/` branches there. Closed PR pages keep their
 * diffs, so the best run's fix survives as a linkable artifact while its refs
 * disappear from clones and branch listings.
 *
 * It runs at arm as well as at stop: a run that is never stopped (the presenter
 * closes the tab, a deploy restarts the box) would otherwise hand its residue
 * to the next investigator.
 *
 * Opt-in: requires INCIDENT_LAB_GITHUB_TOKEN (or GITHUB_TOKEN) with push
 * access to the subject repo. Only refs under `devin/` are ever touched.
 */

const BRANCH_PREFIX = 'devin/';
const REQUEST_TIMEOUT_MS = 15000;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

function sweepToken() {
  return process.env.INCIDENT_LAB_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
}

/** Parse an `owner/repo` out of a repo URL. The host is matched on the parsed
 *  hostname, not anywhere in the string, so a URL like
 *  `https://elsewhere.example/github.com/owner/repo` cannot point the token's
 *  requests at a repository of someone else's choosing. */
function repoFromUrl(repoUrl) {
  let url;
  try {
    url = new URL(repoUrl);
  } catch {
    return null;
  }
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null;
  const [owner, repo] = url.pathname.replace(/^\//, '').split('/');
  if (!owner || !repo) return null;
  return { owner, repo: repo.replace(/\.git$/, '') };
}

function createRepoSweepSink({ request = axios } = {}) {
  async function pages(url, headers) {
    const items = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = await request.get(`${url}&per_page=${PAGE_SIZE}&page=${page}`, { headers, timeout: REQUEST_TIMEOUT_MS });
      const batch = response.data || [];
      items.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }
    return items;
  }

  async function sweep(run) {
    const target = repoFromUrl(run.scenario.repoUrl);
    if (!target) return;
    const token = sweepToken();
    if (!token) {
      logger.info('Incident Lab: no GitHub token (INCIDENT_LAB_GITHUB_TOKEN or GITHUB_TOKEN) — subject-repo sweep skipped');
      return;
    }
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    };
    const slug = `${target.owner}/${target.repo}`;
    const base = `https://api.github.com/repos/${slug}`;
    try {
      for (const pr of await pages(`${base}/pulls?state=open`, headers)) {
        const head = pr.head || {};
        if (!head.ref || !head.ref.startsWith(BRANCH_PREFIX)) continue;
        // A `devin/` head on someone else's fork is a contributor's PR, not
        // this demo's residue: its branch is out of reach anyway, so closing
        // it would only touch a repository the lab does not own.
        if (!head.repo || head.repo.full_name !== slug) continue;
        try {
          await request.patch(`${base}/pulls/${pr.number}`, { state: 'closed' }, { headers, timeout: REQUEST_TIMEOUT_MS });
          logger.info('Incident Lab swept subject-repo fix PR', { runRef: run.runRef, pr: pr.number });
        } catch (error) {
          logger.warn('Incident Lab fix-PR sweep failed', { pr: pr.number, error: error.message });
        }
      }
      for (const branch of await pages(`${base}/branches?protected=false`, headers)) {
        if (!branch.name || !branch.name.startsWith(BRANCH_PREFIX)) continue;
        try {
          await request.delete(`${base}/git/refs/heads/${encodeURIComponent(branch.name)}`, { headers, timeout: REQUEST_TIMEOUT_MS });
          logger.info('Incident Lab swept subject-repo fix branch', { runRef: run.runRef, branch: branch.name });
        } catch (error) {
          logger.warn('Incident Lab fix-branch sweep failed', { branch: branch.name, error: error.message });
        }
      }
    } catch (error) {
      logger.warn('Incident Lab subject-repo sweep failed', { runRef: run.runRef, error: error.message });
    }
  }

  return {
    name: 'repo-sweep',
    async onArm(run) {
      await sweep(run);
    },
    async onStop(run) {
      await sweep(run);
    },
  };
}

module.exports = { createRepoSweepSink, repoFromUrl };
