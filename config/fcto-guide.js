'use strict';

// Request types, required context and the "who to use for what" guide for the
// Field CTO reservation app. Nicole owns this text: edit FOCUS and the guide
// lines here; the request form, cards and `/fcto guide` read from it.

const KINDS = [
  { key: 'MEETING', emoji: ':handshake:', label: 'Customer meeting', blurb: 'The Field CTO reviews it. Admins can also approve.' },
  { key: 'SPEAKING', emoji: ':microphone:', label: 'Earned speaking', blurb: 'Conference, panel, podcast or webinar. The speaking reviewer approves.' },
];

// Minimum characters for the meeting goal / talk topic, to weed out one-liners.
const MIN_GOAL_CHARS = 150;
const MIN_TOPIC_CHARS = 100;

const AUDIENCE_SIZES = [
  { key: 'UNDER_50', label: 'Under 50' },
  { key: '50_200', label: '50–200' },
  { key: '200_1000', label: '200–1,000' },
  { key: 'OVER_1000', label: '1,000+' },
];

// Who reviews earned speaking (comma-separated Slack IDs). Defaults to Nicole
// Zuuring; FCTO_SPEAKING_REVIEWER_IDS replaces the list.
const DEFAULT_SPEAKING_REVIEWER_IDS = 'U0AKUU81BR9';

// Focus areas per Field CTO, shown in `/fcto guide` and the form's suggestion.
// Empty means "not written yet" and is left out.
const FOCUS = {
  JEFF_WANG: '',
  KATRIN_LEHMANN: '',
  MARK_PORTER: '',
  NARRY_SINGH: '',
  AMAN_THIND: '',
  AKIRA_SHIBATA: '',
};

const BEFORE_YOU_ASK = [
  'The most senior customer attendee is Director or above. Below that, work with your SE/AE team.',
  'You can say what the customer wants from a Field CTO and why your SE/AE can\'t cover it.',
  'You know the key attendees (name and title) and can link the Salesforce opportunity and contacts.',
];

const byKey = (list) => Object.fromEntries(list.map((x) => [x.key, x]));

function speakingReviewerIds(env = process.env) {
  const raw = env.FCTO_SPEAKING_REVIEWER_IDS;
  return Array.from(new Set((raw === undefined ? DEFAULT_SPEAKING_REVIEWER_IDS : raw)
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z0-9]{1,32}$/.test(s))));
}

module.exports = {
  KINDS,
  KIND: byKey(KINDS),
  AUDIENCE_SIZES,
  AUDIENCE_SIZE: byKey(AUDIENCE_SIZES),
  MIN_GOAL_CHARS,
  MIN_TOPIC_CHARS,
  FOCUS,
  BEFORE_YOU_ASK,
  speakingReviewerIds,
};
