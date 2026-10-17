'use strict';

// Thin Slack Web API wrapper for the Field CTO app. Kept separate from
// services/slack.js (which is the incident-alert bot) so this app can run on
// its own bot token and so FCTO_SLACK_API_BASE can point at a local stub
// during tests.

const axios = require('axios');
const { URLSearchParams } = require('url');
const logger = require('../../telemetry/logger');

function apiBase() {
  return (process.env.FCTO_SLACK_API_BASE || 'https://slack.com/api').replace(/\/+$/, '');
}

function botToken() {
  return process.env.FCTO_SLACK_BOT_TOKEN || process.env.SLACK_BOT_TOKEN || '';
}

async function call(method, body, { token = botToken(), form = false } = {}) {
  if (!token) {
    logger.warn('fcto: no Slack bot token configured; skipping API call', { method });
    return { ok: false, error: 'no_token' };
  }
  const headers = { Authorization: `Bearer ${token}` };
  let payload = body;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(body).toString();
  } else {
    headers['Content-Type'] = 'application/json; charset=utf-8';
  }
  const response = await axios.post(`${apiBase()}/${method}`, payload, { headers, timeout: 10000 });
  if (!response.data || !response.data.ok) {
    const error = response.data ? response.data.error : 'empty_response';
    logger.warn('fcto: Slack API error', { method, error });
    return { ok: false, error, data: response.data };
  }
  return response.data;
}

const postMessage = (channel, text, blocks, extra = {}) => call('chat.postMessage', { channel, text, blocks, ...extra });
const updateMessage = (channel, ts, text, blocks, extra = {}) => call('chat.update', { channel, ts, text, blocks, ...extra });
const postEphemeral = (channel, user, text, blocks) => call('chat.postEphemeral', { channel, user, text, blocks });
const openView = (triggerId, view) => call('views.open', { trigger_id: triggerId, view });
const updateView = (viewId, view, hash) => call('views.update', { view_id: viewId, view, hash });
const publishHome = (userId, view) => call('views.publish', { user_id: userId, view });
const openDm = (users) => call('conversations.open', { users });
const userInfo = (user) => call('users.info', { user }, { form: true });

// Posts text via Slack's response_url (slash command / interaction follow-up).
async function respond(responseUrl, body) {
  if (!responseUrl) return null;
  try {
    await axios.post(responseUrl, body, { timeout: 10000 });
  } catch (err) {
    logger.warn('fcto: response_url post failed', { error: err.message });
  }
  return null;
}

// Upload a file (the .ics invite, the /fcto calendar PNG) into a channel/thread
// using the v2 upload flow: getUploadURLExternal -> PUT bytes ->
// completeUploadExternal. `content` is a string (UTF-8) or a Buffer.
async function uploadFile({ channel, threadTs, filename, content, contentType = 'text/calendar', title, initialComment }) {
  const token = botToken();
  if (!token) return { ok: false, error: 'no_token' };
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const step1 = await call('files.getUploadURLExternal', { filename, length: bytes.length }, { form: true });
  if (!step1.ok) return step1;
  try {
    await axios.post(step1.upload_url, bytes, {
      headers: { 'Content-Type': contentType },
      timeout: 15000,
    });
  } catch (err) {
    logger.warn('fcto: file upload failed', { filename, error: err.message });
    return { ok: false, error: 'upload_failed' };
  }
  const complete = {
    files: JSON.stringify([{ id: step1.file_id, title: title || filename }]),
  };
  if (channel) complete.channel_id = channel;
  if (threadTs) complete.thread_ts = threadTs;
  if (initialComment) complete.initial_comment = initialComment;
  return call('files.completeUploadExternal', complete, { form: true });
}

module.exports = {
  apiBase,
  botToken,
  call,
  postMessage,
  updateMessage,
  postEphemeral,
  openView,
  updateView,
  publishHome,
  openDm,
  userInfo,
  respond,
  uploadFile,
};
