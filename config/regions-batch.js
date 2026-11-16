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

module.exports = { SLUG, promptAppendix };
