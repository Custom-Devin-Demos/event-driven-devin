const axios = require('axios');
const logger = require('../telemetry/logger');

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

/**
 * Create a Linear issue for a production defect. Returns { id, identifier, url }
 * or null when LINEAR_API_KEY is not configured.
 */
async function createLinearIssue({ title, description, teamId, assigneeId, priority = 2, labelIds = [] }) {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey || !teamId) return null;

  const response = await axios.post(
    LINEAR_GRAPHQL_URL,
    {
      query: `mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) { success issue { id identifier url } }
      }`,
      variables: { input: { title, description, teamId, assigneeId: assigneeId || undefined, priority, labelIds } },
    },
    { headers: { Authorization: apiKey, 'Content-Type': 'application/json' }, timeout: 10000 },
  );

  const payload = response.data || {};
  if (payload.errors && payload.errors.length) {
    throw new Error(payload.errors.map((error) => error.message).join('; '));
  }
  const issue = payload.data && payload.data.issueCreate && payload.data.issueCreate.issue;
  if (!issue) return null;
  logger.info('Linear issue created', { identifier: issue.identifier, url: issue.url });
  return issue;
}

/**
 * Add a comment to a Linear issue. Returns { id, url } or null when the
 * Linear API key is not configured.
 */
async function addLinearComment({ issueId, body }) {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) return null;

  const response = await axios.post(
    LINEAR_GRAPHQL_URL,
    {
      query: `mutation CommentCreate($input: CommentCreateInput!) {
        commentCreate(input: $input) { success comment { id url } }
      }`,
      variables: { input: { issueId, body } },
    },
    { headers: { Authorization: apiKey, 'Content-Type': 'application/json' }, timeout: 10000 },
  );

  const payload = response.data || {};
  if (payload.errors && payload.errors.length) {
    throw new Error(payload.errors.map((error) => error.message).join('; '));
  }
  const comment = payload.data && payload.data.commentCreate && payload.data.commentCreate.comment;
  return comment || null;
}

/**
 * Move a Linear issue to a new workflow state. Returns { id, identifier } or
 * null when the Linear API key is not configured.
 */
async function updateLinearIssueState({ issueId, stateId }) {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) return null;

  const response = await axios.post(
    LINEAR_GRAPHQL_URL,
    {
      query: `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success issue { id identifier } }
      }`,
      variables: { id: issueId, input: { stateId } },
    },
    { headers: { Authorization: apiKey, 'Content-Type': 'application/json' }, timeout: 10000 },
  );

  const payload = response.data || {};
  if (payload.errors && payload.errors.length) {
    throw new Error(payload.errors.map((error) => error.message).join('; '));
  }
  const issue = payload.data && payload.data.issueUpdate && payload.data.issueUpdate.issue;
  return issue || null;
}

module.exports = {
  createLinearIssue,
  addLinearComment,
  updateLinearIssueState,
  LINEAR_GRAPHQL_URL,
};
