const SLUG = 'db10f6b2';

const promptAppendix = [
  'This alert was triggered by PagerDuty for an overnight settlement run. Investigate only COG-GTM/rg-oncall on main, not event-driven-devin. The Incident Ref is the run_id; correlate only that run.',
  'Wait about 90 seconds for all three incidents. Read open PagerDuty incidents on PU8BL8X (Axway MFT), PQZQKW7 (EDW SQL) and PN02JGH (Mainframe Batch zOS), correlating alert body.details.run_id with the Incident Ref. Use the REST API https://api.pagerduty.com with Authorization: Token token=$PAGERDUTY_API_TOKEN, Accept: application/vnd.pagerduty+json;version=2, and From: humza.rabbani@cognition.ai. Never print credentials.',
  'Follow .agents/skills/batch-incident-response/SKILL.md in rg-oncall. Read the MFT, Windows patch/SCHANNEL, ETL and JES2 spool evidence; walk ops/job-dependencies.yaml for the blast radius and owners.',
  'Post a note on EVERY related PagerDuty incident with root cause, evidence, blast radius with owners, HOLD list and rerun order.',
  'Post the same findings in THIS alert Slack thread: a one-line root cause, a HOLD table (job, owner, SLA), and the rerun order. Tag <@U0BQZBHCNMA>; fictional owners stay plain text. Do not create a new top-level Slack message.',
  'Open a fix PR with a regression test and prove the fix with scripts/run-nightly.sh. Note the PR on every related incident and post a final thread reply ending exactly: Awaiting human approval to merge and release holds',
  'Never merge, never resolve incidents, never release operational holds. Reproduce locally only; never fire live PagerDuty events or submit the live console again.',
].join('\n');

function simulatedPrompt(incidents) {
  return [
    'Investigate this overnight settlement run in COG-GTM/rg-oncall on main, not event-driven-devin. The Incident Ref is the run_id.',
    'This is in-app PagerDuty simulation. All three correlated incidents are supplied inline below, including scheduled arrival timestamps. Do NOT call the PagerDuty API, require a PagerDuty token, or post PagerDuty notes. Do not follow the PagerDuty API or note-posting steps in the repository skill; the inline records replace those steps.',
    'Follow .agents/skills/batch-incident-response/SKILL.md for the investigation. Read MFT, Windows patch/SCHANNEL, ETL and JES2 evidence and walk ops/job-dependencies.yaml for dependencies, owners and SLAs.',
    'Post everything in THIS alert Slack thread, never a new top-level message: root cause, evidence, blast radius, a HOLD table (job, owner, SLA), rerun order, fix PR and rerun result. Tag <@U0BQZBHCNMA>; fictional owners remain plain text.',
    'Open a fix PR with a regression test and run scripts/run-nightly.sh. End the final Slack-thread reply exactly: Awaiting human approval to merge and release holds',
    'Never merge, resolve incidents, release operational holds, fire live events or submit the live console again. Reproduce only in the local rg-oncall checkout.',
    `Correlated incidents:\n${JSON.stringify(incidents, null, 2)}`,
  ].join('\n');
}

module.exports = { SLUG, promptAppendix, simulatedPrompt };
