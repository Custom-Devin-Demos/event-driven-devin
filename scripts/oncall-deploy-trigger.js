#!/usr/bin/env node
/**
 * Fires the planted failure + on-call alert for skins that declare
 * `deployTrigger`, right after their skin-creating PR auto-merged and deployed.
 *
 *   node scripts/oncall-deploy-trigger.js --base-url https://devindemos.com c83477cf
 *
 * For each slug: POST deployTrigger.path with X-Oncall-Skin (the real request
 * the customer page makes, so the 504 lands in APM/Sentry), then
 * POST /api/oncall/trigger/<vertical> (the alert the page posts on failure).
 */
/* global fetch */
const { getOncallSkin } = require('../config/oncall-skins');

function parseArgs(argv) {
  const args = { baseUrl: process.env.ONCALL_DEPLOY_TRIGGER_BASE_URL || 'https://devindemos.com', slugs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base-url') args.baseUrl = argv[++i];
    else if (argv[i]) args.slugs.push(argv[i]);
  }
  args.baseUrl = args.baseUrl.replace(/\/+$/, '');
  return args;
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function triggerSkin(baseUrl, slug, { devinEmail = '' } = {}) {
  const skin = getOncallSkin(slug);
  if (!skin) throw new Error(`Unknown on-call skin: ${slug}`);
  if (!skin.deployTrigger) return { slug, skipped: true };
  const { path, body } = skin.deployTrigger;
  const failing = await postJson(`${baseUrl}${path}`, body || {}, { 'X-Oncall-Skin': slug });
  const alert = await postJson(`${baseUrl}/api/oncall/trigger/${skin.vertical}`, {
    unique: true,
    skin: slug,
    devinEmail,
    alertDestination: skin.alertDestination || '',
  });
  return { slug, requestStatus: failing.status, alertStatus: alert.status, alert: alert.data };
}

async function main() {
  const { baseUrl, slugs } = parseArgs(process.argv.slice(2));
  if (!slugs.length) throw new Error('Pass at least one skin slug');
  let failed = false;
  for (const slug of slugs) {
    const result = await triggerSkin(baseUrl, slug, { devinEmail: process.env.DEPLOY_TRIGGER_DEVIN_EMAIL || '' });
    console.log(JSON.stringify(result));
    if (!result.skipped && result.alertStatus !== 200) failed = true;
  }
  if (failed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, triggerSkin };
