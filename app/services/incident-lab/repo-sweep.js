const axios = require('axios');
const logger = require('../../telemetry/logger');

/**
 * Incident Lab subject-repo sweep: when a run stops, the investigator's fix
 * artifacts on the subject repo (fix branches and their open PRs) are
 * demo residue — the next run's investigator would find a ready-made fix
 * and skip the investigation. On stop this sink closes open PRs whose head
 * is a `devin/` branch and deletes `devin/` branches on the scenario's
 * repo. Closed PR pages keep their diffs, so the best run's fix survives
 * as a linkable artifact while its refs disappear from clones and branch
 * listings.
 *
 * Opt-in: requires INCIDENT_LAB_GITHUB_TOKEN (or GITHUB_TOKEN) with push
 * access to the subject repo. Only refs under `devin/` are ever touched.
 */

const BRANCH_PREFIX = 'devin/';
const REQUEST_TIMEOUT_MS = 15000;

function sweepToken() {
  return process.env.INCIDENT_LAB_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
}

function repoFromUrl(repoUrl) {
  const match = /github\.com\/([^/]+)\/([^/#?]+)/.exec(repoUrl || '');
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
}

function createRepoSweepSink({ request = axios } = {}) {
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
    const base = `https://api.github.com/repos/${target.owner}/${target.repo}`;
    try {
      const prs = await request.get(`${base}/pulls?state=open&per_page=100`, { headers, timeout: REQUEST_TIMEOUT_MS });
      for (const pr of prs.data || []) {
        if (!pr.head || !pr.head.ref || !pr.head.ref.startsWith(BRANCH_PREFIX)) continue;
        try {
          await request.patch(`${base}/pulls/${pr.number}`, { state: 'closed' }, { headers, timeout: REQUEST_TIMEOUT_MS });
          logger.info('Incident Lab swept subject-repo fix PR', { runRef: run.runRef, pr: pr.number });
        } catch (error) {
          logger.warn('Incident Lab fix-PR sweep failed', { pr: pr.number, error: error.message });
        }
      }
      const branches = await request.get(`${base}/branches?per_page=100`, { headers, timeout: REQUEST_TIMEOUT_MS });
      for (const branch of branches.data || []) {
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
    async onStop(run) {
      await sweep(run);
    },
  };
}

module.exports = { createRepoSweepSink, repoFromUrl };
