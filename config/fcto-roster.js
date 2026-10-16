'use strict';

// Field CTO roster for the #exec-field-requests reservation app.
//
// Slack member IDs come from the environment so the roster can be completed
// without a code change (FCTO_SLACK_ID_<KEY>). A member with no ID still
// appears in the request form and the schedule; they just cannot be
// @-mentioned, DM'd an invite, or act on their own requests until the ID is
// set. Time zones are IANA names and drive the "local time" shown next to
// every reservation.

const MEMBER_ID_RE = /^[A-Z0-9]{1,32}$/i;

const ROSTER = [
  { key: 'JEFF_WANG', name: 'Jeff Wang', tz: 'America/Los_Angeles', region: 'US', defaultSlackId: 'U09HHJ5B5L5' },
  { key: 'KATRIN_LEHMANN', name: 'Katrin Lehmann', tz: 'Europe/Berlin', region: 'EU', defaultSlackId: 'U0C5GJ3RT63' },
  { key: 'MARK_PORTER', name: 'Mark Porter', tz: 'America/Los_Angeles', region: 'US', defaultSlackId: 'U0BU46F4WCU' },
  { key: 'NARRY_SINGH', name: 'Narry Singh', tz: 'Europe/London', region: 'EU', defaultSlackId: '' },
  { key: 'AMAN_THIND', name: 'Aman Thind', tz: 'Europe/London', region: 'EU', defaultSlackId: 'U0BBSF50MBR' },
  { key: 'AKIRA_SHIBATA', name: 'Akira Shibata', tz: 'Asia/Tokyo', region: 'JP', defaultSlackId: 'U0B1DCC2LAK' },
];

const REGION_LABELS = {
  US: 'US',
  EU: 'EU',
  JP: 'Japan / APAC',
};

function envSlackId(key) {
  const configured = (process.env[`FCTO_SLACK_ID_${key}`] || '').trim();
  return MEMBER_ID_RE.test(configured) ? configured.toUpperCase() : '';
}

function getRoster(env = process.env) {
  return ROSTER.map((member) => {
    const override = (env[`FCTO_SLACK_ID_${member.key}`] || '').trim();
    const slackId = MEMBER_ID_RE.test(override) ? override.toUpperCase() : member.defaultSlackId;
    return { key: member.key, name: member.name, tz: member.tz, region: member.region, slackId };
  });
}

function findMember(keyOrSlackId, env = process.env) {
  if (!keyOrSlackId) return null;
  const needle = String(keyOrSlackId).toUpperCase();
  return getRoster(env).find((m) => m.key === needle || (m.slackId && m.slackId === needle)) || null;
}

// Admins can approve/decline/reassign/cancel anything. Defaults to Jeff Wang.
function getAdminIds(env = process.env) {
  const raw = env.FCTO_ADMIN_SLACK_IDS;
  const list = (raw === undefined ? 'U09HHJ5B5L5' : raw)
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => MEMBER_ID_RE.test(s));
  return Array.from(new Set(list));
}

module.exports = { ROSTER, REGION_LABELS, MEMBER_ID_RE, getRoster, findMember, getAdminIds, envSlackId };
