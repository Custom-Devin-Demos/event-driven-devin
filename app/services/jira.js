const axios = require('axios');
const logger = require('../telemetry/logger');

/**
 * Minimal Jira Cloud REST v3 client (basic auth with an API token).
 *
 * Env vars:
 *   JIRA_BASE_URL   — e.g. https://cog-gtm.atlassian.net (default)
 *   JIRA_EMAIL      — Atlassian account email
 *   JIRA_API_TOKEN  — API token for that account
 */
const DEFAULT_BASE_URL = 'https://cog-gtm.atlassian.net';

function getBaseUrl() {
  return (process.env.JIRA_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
}

function isConfigured() {
  return Boolean(process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN);
}

function client() {
  return axios.create({
    baseURL: `${getBaseUrl()}/rest/api/3`,
    auth: { username: process.env.JIRA_EMAIL, password: process.env.JIRA_API_TOKEN },
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    timeout: 10000,
  });
}

function issueUrl(key) {
  return `${getBaseUrl()}/browse/${key}`;
}

/** Wrap plain text (with newlines) in an Atlassian Document Format doc. */
function adf(text) {
  const paragraphs = String(text).split(/\n{2,}/).map((block) => {
    const lines = block.split('\n');
    const content = [];
    lines.forEach((line, i) => {
      if (i > 0) content.push({ type: 'hardBreak' });
      if (line) content.push({ type: 'text', text: line });
    });
    return { type: 'paragraph', content: content.length ? content : [{ type: 'text', text: ' ' }] };
  });
  return { type: 'doc', version: 1, content: paragraphs };
}

async function getIssue(key) {
  const { data } = await client().get(`/issue/${key}`, {
    params: { fields: 'summary,status,assignee,reporter,labels,fixVersions,issuetype,updated' },
  });
  return {
    key: data.key,
    url: issueUrl(data.key),
    summary: data.fields.summary,
    status: data.fields.status?.name || 'Unknown',
    statusCategory: data.fields.status?.statusCategory?.key || 'undefined',
    issueType: data.fields.issuetype?.name || '',
    labels: data.fields.labels || [],
    fixVersions: (data.fields.fixVersions || []).map((v) => v.name),
    assignee: data.fields.assignee
      ? { accountId: data.fields.assignee.accountId, displayName: data.fields.assignee.displayName }
      : null,
    reporter: data.fields.reporter
      ? { accountId: data.fields.reporter.accountId, displayName: data.fields.reporter.displayName }
      : null,
    updated: data.fields.updated,
  };
}

async function addComment(key, text) {
  const { data } = await client().post(`/issue/${key}/comment`, { body: adf(text) });
  return { id: data.id, url: `${issueUrl(key)}?focusedCommentId=${data.id}` };
}

async function transitionTo(key, statusName) {
  const api = client();
  const { data } = await api.get(`/issue/${key}/transitions`);
  const match = (data.transitions || []).find(
    (t) => t.to?.name?.toLowerCase() === statusName.toLowerCase(),
  );
  if (!match) {
    logger.warn('Jira transition not available', { key, statusName });
    return false;
  }
  await api.post(`/issue/${key}/transitions`, { transition: { id: match.id } });
  return true;
}

async function assign(key, accountId) {
  await client().put(`/issue/${key}/assignee`, { accountId: accountId || null });
  return true;
}

module.exports = {
  isConfigured,
  getBaseUrl,
  issueUrl,
  adf,
  getIssue,
  addComment,
  transitionTo,
  assign,
};
