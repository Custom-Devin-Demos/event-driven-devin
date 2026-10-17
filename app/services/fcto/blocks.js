'use strict';

// Block Kit builders for the Field CTO reservation app.

const { getRoster, findMember, REGION_LABELS, getAdminIds } = require('../../../config/fcto-roster');
const R = require('./reservations');
const Q = require('../../../config/fcto-qualifications');
const G = require('../../../config/fcto-guide');
const avatars = require('./avatars');
const { calendarLinks } = require('./ics');

const CALLBACK = Object.freeze({
  REQUEST: 'fcto_request_submit',
  DECLINE: 'fcto_decline_submit',
  ASSIGN: 'fcto_assign_submit',
});

const ACTION = Object.freeze({
  NEW_REQUEST: 'fcto_new_request',
  APPROVE: 'fcto_approve',
  DECLINE: 'fcto_decline',
  CLAIM: 'fcto_claim',
  ASSIGN: 'fcto_assign',
  CANCEL: 'fcto_cancel',
  REFRESH_HOME: 'fcto_refresh_home',
  NOOP: 'fcto_noop',
  CAL_GOOGLE: 'fcto_cal_google',
  CAL_OUTLOOK: 'fcto_cal_outlook',
});

// URL buttons still send a block_actions payload; the router ignores these.
const LINK_ACTIONS = new Set([ACTION.NOOP, ACTION.CAL_GOOGLE, ACTION.CAL_OUTLOOK]);

// `color` is the bar beside the card's status section.
const STATUS_META = {
  [R.STATUS.PENDING]: { emoji: ':hourglass_flowing_sand:', label: 'Pending', color: '#ECB22E' },
  [R.STATUS.APPROVED]: { emoji: ':white_check_mark:', label: 'Approved', color: '#2EB67D' },
  [R.STATUS.DECLINED]: { emoji: ':no_entry_sign:', label: 'Declined', color: '#E01E5A' },
  [R.STATUS.CANCELLED]: { emoji: ':wastebasket:', label: 'Cancelled', color: '#9AA0A6' },
};

const REGION_ZONES = { US: 'America/Los_Angeles', EU: 'Europe/Berlin', JP: 'Asia/Tokyo' };

function plain(text, emoji = true) {
  return { type: 'plain_text', text: String(text).slice(0, 150), emoji };
}

// User-entered text goes through esc() so it can't carry mrkdwn control
// sequences (<@U…> mentions, <!channel>, links) into app-authored cards.
function esc(text) {
  return String(text == null ? '' : text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function mrkdwn(text) {
  return { type: 'mrkdwn', text: String(text).slice(0, 3000) };
}

function section(text, extra = {}) {
  return { type: 'section', text: mrkdwn(text), ...extra };
}

function context(...texts) {
  return { type: 'context', elements: texts.filter(Boolean).map(mrkdwn).slice(0, 10) };
}

function mention(member) {
  if (!member) return '_unassigned_';
  return member.slackId ? `<@${member.slackId}> (${member.name})` : `*${member.name}*`;
}

function avatarImage(member) {
  const url = member && avatars.get(member.slackId);
  return url ? { type: 'image', image_url: url, alt_text: member.name } : null;
}

// ":crown: VP   :flag-de: Germany   :bank: Finance"; empty for older requests.
function qualChips(res) {
  return [Q.AUDIENCE[res.audience], Q.COUNTRY[res.country], Q.INDUSTRY[res.industry]]
    .filter(Boolean).map((x) => `${x.emoji} ${x.label}`).join('   ');
}

function memberLabel(member) {
  const zone = R.formatInTz(Math.floor(Date.now() / 1000), member.tz).zone;
  return `${member.name} — ${REGION_LABELS[member.region] || member.region} (${zone})`;
}

function whoOptions(env = process.env) {
  const members = getRoster(env).map((m) => ({ text: plain(memberLabel(m)), value: `MEMBER:${m.key}` }));
  const any = Object.entries(R.PREFERENCES).map(([key, label]) => ({ text: plain(label), value: `ANY:${key}` }));
  return [
    { label: plain('Any available Field CTO'), options: any },
    { label: plain('A specific Field CTO'), options: members },
  ];
}

function durationOptions() {
  return Object.entries(R.DURATIONS).map(([key, d]) => ({ text: plain(d.label), value: key }));
}

// ─── Request modal ──────────────────────────────────────────────────────────

const qualOptions = (list) => list.map((x) => ({ text: plain(x.emoji ? `${x.emoji} ${x.label}` : x.label), value: x.key }));

function qualSelect(blockId, label, list, placeholder) {
  return {
    type: 'input',
    block_id: blockId,
    dispatch_action: true,
    label: plain(label),
    element: { type: 'static_select', action_id: 'value', placeholder: plain(placeholder), options: qualOptions(list) },
  };
}

// The "who" block id carries the suggestion so Slack re-applies initial_option
// when the suggestion changes but keeps a manual pick while it stays the same.
const whoBlockId = (suggestion) => (suggestion ? `who_${suggestion.who.replace(/[^A-Za-z0-9]/g, '_')}` : 'who');

function suggestionCallout(suggestion) {
  const key = suggestion.who.startsWith('MEMBER:') ? suggestion.who.slice('MEMBER:'.length) : null;
  const member = key ? findMember(key) : null;
  if (member) {
    const t = R.formatInTz(Math.floor(Date.now() / 1000), member.tz);
    const image = avatarImage(member);
    const focus = G.FOCUS[member.key] ? `\n_Focus: ${esc(G.FOCUS[member.key])}_` : '';
    return section(`:sparkles: *Suggested: ${member.name}* for ${suggestion.reason}\n${REGION_LABELS[member.region]} · it's ${t.time} ${t.zone} for them now${focus}`, image ? { accessory: image } : {});
  }
  const pref = R.PREFERENCES[suggestion.who.slice('ANY:'.length)];
  return section(`:sparkles: *Suggested: ${pref || 'any Field CTO'}* for ${suggestion.reason}`);
}

const stepHeader = (text) => ({ type: 'header', text: plain(text) });

const AVAILABILITY_NOTE = 'Approved reservations in this app only, not personal calendars. You can still request someone who is booked; an admin decides.';

// "Is the Field CTO free then?" for the request form's current who + time.
// `check` is { who, startTs, endTs, results } with results from R.whoIsFree.
function availabilityCallout(check) {
  if (!check || !check.results || !check.results.length) return [];
  const booked = ({ member, conflicts }) => conflicts.map((c) => `${R.formatRangeInTz(c.startTs, c.endTs, member.tz)} (${c.id})`).join(', ');
  const lines = [];
  if (check.who.startsWith('MEMBER:')) {
    const hit = check.results[0];
    lines.push(hit.conflicts.length
      ? `:red_circle: *${hit.member.name} is already booked then:* ${booked(hit)}`
      : `:large_green_circle: *${hit.member.name} is free then* · ${R.formatRangeInTz(check.startTs, check.endTs, hit.member.tz)} for them`);
  } else {
    const free = check.results.filter((r) => !r.conflicts.length);
    const busy = check.results.filter((r) => r.conflicts.length);
    const label = R.PREFERENCES[check.who.slice('ANY:'.length)] || R.PREFERENCES.ANY;
    lines.push(free.length
      ? `:large_green_circle: *Free then:* ${free.map((r) => r.member.name).join(', ')}`
      : `:red_circle: *Nobody for "${label}" is free then*`);
    if (busy.length) lines.push(`:red_circle: *Booked:* ${busy.map((r) => `${r.member.name} — ${booked(r)}`).join(' · ')}`);
  }
  return [section(lines.join('\n')), context(AVAILABILITY_NOTE)];
}

// Block id the who select will get for a suggestion (see whoBlockId).
const whoBlockIdFor = (suggestion) => whoBlockId(suggestion && findWhoOption(suggestion.who) ? suggestion : null);

function findWhoOption(value) {
  for (const group of whoOptions()) {
    const hit = group.options.find((o) => o.value === value);
    if (hit) return hit;
  }
  return null;
}

const kindOption = (k) => ({ text: plain(`${k.emoji} ${k.label}`), description: plain(k.blurb.slice(0, 75)), value: k.key });

function textInput(blockId, label, { optional = false, multiline = false, max = 500, min, placeholder, hint, type = 'plain_text_input' } = {}) {
  return {
    type: 'input',
    block_id: blockId,
    ...(optional ? { optional: true } : {}),
    label: plain(label),
    ...(hint ? { hint: plain(hint) } : {}),
    element: {
      type,
      action_id: 'value',
      ...(type === 'plain_text_input' ? { max_length: max, ...(multiline ? { multiline: true } : {}), ...(min ? { min_length: min } : {}) } : {}),
      ...(placeholder ? { placeholder: plain(placeholder) } : {}),
    },
  };
}

// The blocks that differ between a customer meeting and earned speaking.
function meetingBlocks(audience) {
  return {
    about: [
      textInput('account', 'Account / customer', { max: 120, placeholder: 'e.g. Acme Corp — EBC' }),
      textInput('purpose', 'Meeting goal', {
        multiline: true,
        max: 1000,
        min: G.MIN_GOAL_CHARS,
        placeholder: 'What does the customer want from a Field CTO? Why can\'t the SE/AE cover it? What happens next if it goes well?',
        hint: `At least ${G.MIN_GOAL_CHARS} characters. The more context, the faster the Field CTO can say yes.`,
      }),
    ],
    room: [
      stepHeader(":busts_in_silhouette: Who's in the room"),
      textInput('attendees', 'Key customer attendees', { multiline: true, placeholder: 'Jane Doe — CIO\nRaj Patel — VP Engineering' }),
      qualSelect('audience', 'Audience', Q.AUDIENCES, 'Most senior customer attendee'),
      ...(Q.AUDIENCE[audience] && !Q.AUDIENCE[audience].eligible ? [section(`:no_entry: *Field CTOs can't take this one.* ${Q.BELOW_MESSAGE}`)] : []),
      qualSelect('country', 'Country', Q.COUNTRIES, 'Where the customer is'),
      qualSelect('industry', 'Industry', Q.INDUSTRIES, 'Customer industry'),
    ],
    extras: [
      stepHeader(':cloud: Salesforce'),
      textInput('opportunityUrl', 'Opportunity link', { optional: true, type: 'url_text_input', placeholder: 'https://….lightning.force.com/lightning/r/Opportunity/006…/view', hint: 'Optional, but the card flags requests without one.' }),
      textInput('contactUrls', 'Contact record links', { optional: true, multiline: true, max: 3000, placeholder: 'One Salesforce Contact URL per line, for the key attendees' }),
      stepHeader(':paperclip: Extras'),
      textInput('meetingLink', 'Meeting link', { optional: true, type: 'url_text_input', placeholder: 'https://…' }),
    ],
  };
}

function speakingBlocks() {
  return {
    about: [
      textInput('account', 'Event name', { max: 120, placeholder: 'e.g. AWS re:Invent 2026 — CIO panel' }),
      textInput('purpose', 'Talk topic and why it needs a Field CTO', {
        multiline: true,
        max: 1000,
        min: G.MIN_TOPIC_CHARS,
        placeholder: 'Session format, topic, who\'s in the audience and what we get out of it',
        hint: `At least ${G.MIN_TOPIC_CHARS} characters.`,
      }),
    ],
    room: [
      stepHeader(':ticket: The event'),
      textInput('eventUrl', 'Event link', { type: 'url_text_input', placeholder: 'https://…' }),
      {
        type: 'input',
        block_id: 'audienceSize',
        label: plain('Expected audience size'),
        element: { type: 'static_select', action_id: 'value', placeholder: plain('How many people'), options: G.AUDIENCE_SIZES.map((x) => ({ text: plain(x.label), value: x.key })) },
      },
      {
        type: 'input',
        block_id: 'deadline',
        optional: true,
        label: plain('Need an answer by'),
        hint: plain('e.g. the speaker submission deadline'),
        element: { type: 'datepicker', action_id: 'value' },
      },
      qualSelect('country', 'Event country', Q.COUNTRIES, 'Where the event is'),
    ],
    extras: [stepHeader(':paperclip: Extras')],
  };
}

// `kind`/`audience`/`suggestion`/`availability` come from the requester's
// current picks (see routes/fcto.js): the request type, a "Below" warning, a
// pre-selected Field CTO and whether they are free at the chosen time.
function requestModal({ channelId, defaultStartTs, kind, audience, suggestion, availability } = {}) {
  const start = defaultStartTs || (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(17, 0, 0, 0); // 10am PT / 7pm CET-ish default
    return Math.floor(d.getTime() / 1000);
  })();
  const kindDef = G.KIND[kind] || G.KIND.MEETING;
  const speaking = kindDef.key === 'SPEAKING';
  const parts = speaking ? speakingBlocks() : meetingBlocks(audience);
  const reviewers = G.speakingReviewerIds().map((id) => `<@${id}>`).join(', ') || 'the speaking reviewer';
  return {
    type: 'modal',
    callback_id: CALLBACK.REQUEST,
    private_metadata: JSON.stringify({ channelId: channelId || null }),
    title: plain('Reserve a Field CTO'),
    submit: plain('Submit request'),
    close: plain('Cancel'),
    blocks: [
      context(`:wave: Requests post to ${channelId ? `<#${channelId}>` : 'the requests channel'}. ${speaking ? `Earned speaking is approved by ${reviewers}.` : 'The Field CTO reviews meetings; admins can also approve.'} Not sure who to ask? \`/fcto guide\``),
      {
        type: 'input',
        block_id: 'kind',
        dispatch_action: true,
        label: plain('Request type'),
        element: { type: 'static_select', action_id: 'value', options: G.KINDS.map(kindOption), initial_option: kindOption(kindDef) },
      },
      stepHeader(speaking ? ':microphone: The talk' : ':office: The meeting'),
      ...parts.about,
      ...parts.room,
      ...(suggestion && findWhoOption(suggestion.who) ? [suggestionCallout(suggestion)] : []),
      (() => {
        const initial = suggestion && findWhoOption(suggestion.who);
        return {
          type: 'input',
          block_id: whoBlockId(initial ? suggestion : null),
          dispatch_action: true,
          label: plain(speaking ? 'Who should speak?' : 'Who do you need?'),
          ...(initial ? { hint: plain(`Suggested for ${suggestion.reason}. You can pick someone else.`) } : {}),
          element: {
            type: 'static_select',
            action_id: 'value',
            placeholder: plain('Pick a Field CTO or "any"'),
            option_groups: whoOptions(),
            ...(initial ? { initial_option: initial } : {}),
          },
        };
      })(),
      stepHeader(':calendar: When'),
      {
        type: 'input',
        block_id: 'start',
        dispatch_action: true,
        label: plain('Start'),
        hint: plain('Shown in your Slack time zone. Field CTOs see it in theirs.'),
        element: { type: 'datetimepicker', action_id: 'value', initial_date_time: start },
      },
      {
        type: 'input',
        block_id: 'duration',
        dispatch_action: true,
        label: plain('Duration'),
        element: {
          type: 'static_select',
          action_id: 'value',
          options: durationOptions(),
          initial_option: { text: plain(R.DURATIONS['1h'].label), value: '1h' },
        },
      },
      {
        type: 'input',
        block_id: 'end',
        optional: true,
        dispatch_action: true,
        label: plain('End (only for "Custom end time")'),
        hint: plain('Use this for multi-day blocks like an onsite or a conference.'),
        element: { type: 'datetimepicker', action_id: 'value' },
      },
      ...availabilityCallout(availability),
      ...parts.extras,
      textInput('notes', 'Notes for the Field CTO', { optional: true, multiline: true }),
    ],
  };
}

// Pull the submitted values out of a view_submission payload.
function readRequestModal(view) {
  const v = view.state.values;
  const pick = (block) => (v[block] && v[block].value) || {};
  const meta = (() => { try { return JSON.parse(view.private_metadata || '{}'); } catch { return {}; } })();
  return {
    kind: (pick('kind').selected_option || {}).value,
    account: pick('account').value,
    purpose: pick('purpose').value,
    audience: (pick('audience').selected_option || {}).value,
    country: (pick('country').selected_option || {}).value,
    industry: (pick('industry').selected_option || {}).value,
    who: (pick(Object.keys(v).find((k) => k === 'who' || k.startsWith('who_')) || 'who').selected_option || {}).value,
    startTs: pick('start').selected_date_time,
    durationKey: (pick('duration').selected_option || {}).value,
    endTs: pick('end').selected_date_time,
    meetingLink: pick('meetingLink').value,
    attendees: pick('attendees').value,
    opportunityUrl: pick('opportunityUrl').value,
    contactUrls: pick('contactUrls').value,
    eventUrl: pick('eventUrl').value,
    audienceSize: (pick('audienceSize').selected_option || {}).value,
    deadline: pick('deadline').selected_date,
    notes: pick('notes').value,
    channelId: meta.channelId,
  };
}

// Map a ReservationError.field to the modal block id for an inline error.
function modalErrors(err, view) {
  let field = err && err.field;
  if (!field) return null;
  const values = (view && view.state && view.state.values) || {};
  if (field === 'who') field = Object.keys(values).find((k) => k === 'who' || k.startsWith('who_')) || field;
  return { response_action: 'errors', errors: { [field]: err.message } };
}

// ─── Decline / assign modals ────────────────────────────────────────────────

function declineModal(reservation) {
  return {
    type: 'modal',
    callback_id: CALLBACK.DECLINE,
    private_metadata: JSON.stringify({ id: reservation.id }),
    title: plain(`Decline ${reservation.id}`),
    submit: plain('Decline request'),
    close: plain('Back'),
    blocks: [
      section(`*${esc(reservation.account)}* · ${R.describeWho(reservation)}\n${R.slackRange(reservation.startTs, reservation.endTs)}`),
      {
        type: 'input',
        block_id: 'reason',
        optional: true,
        label: plain('Reason (shared with the requester)'),
        element: { type: 'plain_text_input', action_id: 'value', multiline: true, max_length: 500 },
      },
    ],
  };
}

// Used for "Assign" on open requests, "Reassign" on anything, and as the
// conflict-override confirmation when an approve/claim collides.
function assignModal(store, reservation, { mode = 'assign', preselectKey = null, warning = null } = {}) {
  const candidates = R.suggestAssignees(store, reservation);
  const options = candidates.map((m) => ({
    text: plain(`${m.conflicts.length ? ':warning: ' : ''}${memberLabel(m)}${m.recommended ? ' · recommended' : ''}${m.preferred || m.recommended ? '' : ' · other region'}`),
    value: m.key,
  }));
  const recommended = candidates.find((m) => m.recommended && !m.conflicts.length);
  const initialKey = preselectKey || (recommended ? recommended.key : null);
  const initial = initialKey ? options.find((o) => o.value === initialKey) : null;
  const titles = { assign: 'Assign a Field CTO', reassign: `Reassign ${reservation.id}`, approve: `Approve ${reservation.id}`, claim: `Claim ${reservation.id}` };
  const blocks = [
    section(`*${esc(reservation.account)}* — ${esc(reservation.purpose)}\n${R.slackRange(reservation.startTs, reservation.endTs)} · ${R.durationLabel(reservation)}\nRequested: ${R.describeWho(reservation)}`),
  ];
  if (warning) blocks.push(section(`:warning: ${warning}`));
  const busy = candidates.filter((m) => m.conflicts.length);
  if (busy.length) {
    blocks.push(context(`Already reserved in this window: ${busy.map((m) => `${m.name} (${m.conflicts.map((c) => c.id).join(', ')})`).join(' · ')}`));
  }
  blocks.push({
    type: 'input',
    block_id: 'assignee',
    label: plain('Field CTO'),
    element: {
      type: 'static_select',
      action_id: 'value',
      placeholder: plain('Pick a Field CTO'),
      options,
      ...(initial ? { initial_option: initial } : {}),
    },
  });
  blocks.push({
    type: 'input',
    block_id: 'force',
    optional: true,
    label: plain('Conflicts'),
    element: {
      type: 'checkboxes',
      action_id: 'value',
      options: [{ text: plain('Book anyway, even if this Field CTO is already reserved'), value: 'force' }],
    },
  });
  return {
    type: 'modal',
    callback_id: CALLBACK.ASSIGN,
    private_metadata: JSON.stringify({ id: reservation.id, mode }),
    title: plain(titles[mode] || titles.assign),
    submit: plain(mode === 'reassign' ? 'Reassign' : 'Approve'),
    close: plain('Back'),
    blocks,
  };
}

function readAssignModal(view) {
  const v = view.state.values;
  const meta = (() => { try { return JSON.parse(view.private_metadata || '{}'); } catch { return {}; } })();
  const assignee = ((v.assignee || {}).value || {}).selected_option;
  const forceOpts = ((v.force || {}).value || {}).selected_options || [];
  return { id: meta.id, mode: meta.mode, assigneeKey: assignee ? assignee.value : null, force: forceOpts.some((o) => o.value === 'force') };
}

function readDeclineModal(view) {
  const v = view.state.values;
  const meta = (() => { try { return JSON.parse(view.private_metadata || '{}'); } catch { return {}; } })();
  return { id: meta.id, reason: ((v.reason || {}).value || {}).value || '' };
}

// ─── Request card ───────────────────────────────────────────────────────────

function localTimesLine(reservation) {
  const member = findMember(reservation.assigneeKey || reservation.requestedKey);
  if (member) {
    return `*${member.name}'s local time:* ${R.formatRangeInTz(reservation.startTs, reservation.endTs, member.tz)}`;
  }
  const regions = reservation.preference && reservation.preference !== 'ANY' ? [reservation.preference] : ['US', 'EU', 'JP'];
  return regions.map((r) => `*${REGION_LABELS[r]}:* ${R.formatRangeInTz(reservation.startTs, reservation.endTs, REGION_ZONES[r])}`).join('\n');
}

function statusLine(reservation) {
  const meta = STATUS_META[reservation.status];
  const assignee = findMember(reservation.assigneeKey);
  switch (reservation.status) {
    case R.STATUS.APPROVED:
      return `${meta.emoji} *Approved* — ${mention(assignee)} is reserved${reservation.decidedBy ? ` · approved by <@${reservation.decidedBy}>` : ''}`;
    case R.STATUS.DECLINED:
      return `${meta.emoji} *Declined*${reservation.decidedBy ? ` by <@${reservation.decidedBy}>` : ''}${reservation.declineReason ? ` — ${esc(reservation.declineReason)}` : ''}`;
    case R.STATUS.CANCELLED:
      return `${meta.emoji} *Cancelled*`;
    default:
      if (R.kindOf(reservation) === 'speaking') {
        const reviewers = G.speakingReviewerIds().map((id) => `<@${id}>`).join(', ') || 'an admin';
        return `${meta.emoji} *Pending* — earned speaking, waiting on ${reviewers} to ${reservation.requestType === 'any' ? 'assign a speaker' : 'approve'}`;
      }
      return reservation.requestType === 'any'
        ? `${meta.emoji} *Pending* — open to any Field CTO${reservation.preference && reservation.preference !== 'ANY' ? ` (${REGION_LABELS[reservation.preference]} hours preferred)` : ''}. Field CTOs can *Claim*; admins can *Assign*.`
        : `${meta.emoji} *Pending* — waiting on ${mention(assignee)} or an admin`;
  }
}

// "✅ Requested → ✅ Field CTO: Mark → ⏳ Approval"
function progressLine(reservation) {
  const done = ':white_check_mark:';
  const assignee = findMember(reservation.assigneeKey);
  const steps = [`${done} Requested`];
  if (reservation.status === R.STATUS.DECLINED) steps.push(':x: Declined');
  else if (reservation.status === R.STATUS.CANCELLED) steps.push(':wastebasket: Cancelled');
  else {
    steps.push(assignee ? `${done} Field CTO: ${assignee.name.split(' ')[0]}` : ':hourglass_flowing_sand: Field CTO');
    if (reservation.status === R.STATUS.APPROVED) steps.push(`${done} Approved`, ':calendar: On the calendar');
    else steps.push(`${assignee ? ':hourglass_flowing_sand:' : ':white_circle:'} Approval`, ':white_circle: On the calendar');
  }
  return steps.join('  →  ');
}

function calendarButtons(reservation, blockId) {
  const links = calendarLinks(reservation);
  return {
    type: 'actions',
    block_id: blockId,
    elements: [
      { type: 'button', text: plain(':calendar: Add to Google Calendar'), action_id: ACTION.CAL_GOOGLE, url: links.google },
      { type: 'button', text: plain(':calendar: Add to Outlook'), action_id: ACTION.CAL_OUTLOOK, url: links.outlook },
    ],
  };
}

function cardActions(reservation, conflicts) {
  if (reservation.status === R.STATUS.DECLINED || reservation.status === R.STATUS.CANCELLED) return null;
  const btn = (text, actionId, style, confirm) => ({
    type: 'button',
    text: plain(text),
    action_id: actionId,
    value: reservation.id,
    ...(style ? { style } : {}),
    ...(confirm ? { confirm } : {}),
  });
  const elements = [];
  if (reservation.status === R.STATUS.PENDING) {
    if (reservation.requestType === 'specific') {
      elements.push(btn(conflicts.length ? 'Approve (conflict)' : 'Approve', ACTION.APPROVE, conflicts.length ? undefined : 'primary'));
    } else if (R.kindOf(reservation) === 'speaking') {
      elements.push(btn('Assign…', ACTION.ASSIGN, 'primary'));
    } else {
      elements.push(btn('Claim', ACTION.CLAIM, 'primary'));
      elements.push(btn('Assign…', ACTION.ASSIGN));
    }
    elements.push(btn('Decline', ACTION.DECLINE, 'danger'));
    if (reservation.requestType === 'specific') elements.push(btn('Reassign…', ACTION.ASSIGN));
  } else {
    elements.push(btn('Reassign…', ACTION.ASSIGN));
  }
  elements.push(btn('Cancel request', ACTION.CANCEL, undefined, {
    title: plain('Cancel this request?'),
    text: mrkdwn(`This releases ${reservation.id}. Only the requester or an admin can do this.`),
    confirm: plain('Yes, cancel it'),
    deny: plain('Keep it'),
  }));
  return { type: 'actions', block_id: `actions_${reservation.id}`, elements };
}

const MAX_LINKS_TEXT = 2900;

function deadlineLabel(date) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
}

// Salesforce links as buttons-free mrkdwn links (URLs are validated in
// R.createRequest), or a warning for the reviewer when they're missing.
function salesforceBlocks(reservation) {
  const contacts = reservation.contactUrls || [];
  const links = [
    reservation.opportunityUrl ? `<${esc(reservation.opportunityUrl)}|Opportunity>` : null,
    ...contacts.map((u, i) => `<${esc(u)}|Contact ${i + 1}>`),
  ].filter(Boolean);
  const missing = [
    reservation.opportunityUrl ? null : 'opportunity',
    contacts.length ? null : 'contact records',
  ].filter(Boolean);
  const blocks = [];
  // Split so no mrkdwn text passes Slack's 3,000-character limit mid-link.
  const chunks = [];
  links.forEach((link) => {
    const last = chunks[chunks.length - 1];
    if (last && last.length + link.length + 5 <= MAX_LINKS_TEXT) chunks[chunks.length - 1] = `${last}  ·  ${link}`;
    else chunks.push(`${chunks.length ? '' : ':cloud: *Salesforce:* '}${link}`);
  });
  chunks.forEach((text) => blocks.push(context(text)));
  if (missing.length) blocks.push(context(`:warning: *No Salesforce ${missing.join(' or ')} linked.* Ask the requester before approving.`));
  return blocks;
}

// The request details: who/when (with the Field CTO's photo), qualification
// chips, the purpose as a block quote, and local times.
function cardDetailBlocks(reservation, conflicts) {
  const member = findMember(reservation.assigneeKey || reservation.requestedKey);
  const image = avatarImage(member);
  const speaking = R.kindOf(reservation) === 'speaking';
  const blocks = [
    { type: 'header', text: plain(speaking ? `:microphone: Earned speaking request ${reservation.id}` : `:briefcase: Field CTO request ${reservation.id}`) },
    section([
      speaking ? `*Event*  ${esc(reservation.account)}` : `*${esc(reservation.account)}*`,
      `*Who*  ${R.describeWho(reservation)}`,
      `*When*  ${R.slackRange(reservation.startTs, reservation.endTs)} · ${R.durationLabel(reservation)}`,
      `*Requested by*  <@${reservation.requesterId}>`,
    ].join('\n'), image ? { accessory: image } : {}),
  ];
  const chips = qualChips(reservation);
  if (chips) blocks.push(context(chips));
  const purposeLabel = { speaking: 'Talk', meeting: 'Meeting goal' }[reservation.kind] || 'Purpose';
  blocks.push(section(`*${purposeLabel}*\n>${esc(reservation.purpose).replace(/\n/g, '\n>')}`));
  if (reservation.attendees) blocks.push(section(`:busts_in_silhouette: *Key attendees*\n${esc(reservation.attendees)}`));
  if (reservation.kind === 'meeting') blocks.push(...salesforceBlocks(reservation));
  if (speaking) {
    const size = G.AUDIENCE_SIZE[reservation.audienceSize];
    blocks.push(context([
      reservation.eventUrl ? `:link: <${esc(reservation.eventUrl)}|Event page>` : null,
      size ? `:busts_in_silhouette: Audience ${size.label}` : null,
      reservation.deadline ? `:alarm_clock: Answer needed by ${deadlineLabel(reservation.deadline)}` : null,
    ].filter(Boolean).join('  ·  ')));
  }
  if (reservation.notes) blocks.push(section(`:memo: *Notes*\n${esc(reservation.notes)}`));
  if (reservation.meetingLink) blocks.push(context(`:link: <${esc(reservation.meetingLink)}>`));
  blocks.push({ type: 'context', elements: [...(image ? [image] : []), mrkdwn(localTimesLine(reservation))] });
  if (conflicts.length && reservation.status === R.STATUS.PENDING) {
    blocks.push(section(`:warning: *Conflict:* ${conflicts.map((c) => `${c.id} (${esc(c.account)}, ${R.slackRange(c.startTs, c.endTs)})`).join('; ')}`));
  }
  return blocks;
}

function cardStatusBlocks(reservation, conflicts) {
  const blocks = [context(progressLine(reservation)), section(statusLine(reservation))];
  const actions = cardActions(reservation, conflicts);
  if (actions) blocks.push(actions);
  if (reservation.status === R.STATUS.APPROVED) blocks.push(calendarButtons(reservation, `cal_${reservation.id}`));
  return blocks;
}

function requestCard(reservation, { conflicts = [] } = {}) {
  return [...cardDetailBlocks(reservation, conflicts), ...cardStatusBlocks(reservation, conflicts)];
}

// chat.postMessage / chat.update payload: details as blocks, status in a
// colored attachment so pending/approved/declined read at a glance.
function requestCardMessage(reservation, { conflicts = [] } = {}) {
  const meta = STATUS_META[reservation.status];
  return {
    text: cardText(reservation),
    blocks: cardDetailBlocks(reservation, conflicts),
    attachments: [{ color: meta.color, fallback: `${meta.label}: ${reservation.id}`, blocks: cardStatusBlocks(reservation, conflicts) }],
  };
}

function cardText(reservation) {
  const member = findMember(reservation.assigneeKey || reservation.requestedKey);
  return `[${STATUS_META[reservation.status].label}] Field CTO request ${reservation.id}: ${esc(reservation.account)} — ${member ? member.name : R.describeWho(reservation)}, ${R.formatRangeInTz(reservation.startTs, reservation.endTs, 'UTC')}`;
}

// Approved thread reply: the note, the Field CTO's photo and calendar buttons.
function threadBlocks(reservation) {
  if (reservation.status !== R.STATUS.APPROVED) return undefined;
  const image = avatarImage(findMember(reservation.assigneeKey));
  return [
    section(`:tada: ${threadNote(reservation)}`, image ? { accessory: image } : {}),
    calendarButtons(reservation, `thread_cal_${reservation.id}`),
  ];
}

function threadNote(reservation) {
  const assignee = findMember(reservation.assigneeKey);
  switch (reservation.status) {
    case R.STATUS.APPROVED:
      return `<@${reservation.requesterId}> ${mention(assignee)} is reserved for *${esc(reservation.account)}* — ${R.slackRange(reservation.startTs, reservation.endTs)}${assignee ? ` (${R.formatRangeInTz(reservation.startTs, reservation.endTs, assignee.tz)} for ${assignee.name.split(' ')[0]})` : ''}. Calendar invite attached below.`;
    case R.STATUS.DECLINED:
      return `<@${reservation.requesterId}> this request was declined${reservation.declineReason ? `: ${esc(reservation.declineReason)}` : '.'}`;
    case R.STATUS.CANCELLED:
      return `Request ${reservation.id} was cancelled.`;
    default:
      return `Request ${reservation.id} updated.`;
  }
}

// ─── Schedule & App Home ────────────────────────────────────────────────────

function dayKey(ts, tz) {
  return R.formatInTz(ts, tz).day;
}

function scheduleBlocks(store, { from, to, title, memberKey, tz = 'UTC', viewerId } = {}) {
  const items = R.listReservations(store, { from, to, memberKey });
  const blocks = [{ type: 'header', text: plain(title || 'Field CTO schedule') }];
  if (!items.length) {
    blocks.push(section('_Nothing on the books for this window._'));
    return blocks;
  }
  const byDay = new Map();
  items.forEach((r) => {
    const key = dayKey(r.startTs, tz);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(r);
  });
  byDay.forEach((list, day) => {
    const lines = list.map((r) => {
      const member = findMember(r.assigneeKey || r.requestedKey);
      const who = member ? `*${member.name}*` : `_${R.describeWho(r)}_`;
      const pending = r.status === R.STATUS.PENDING ? ' · :hourglass_flowing_sand: pending' : '';
      const mine = viewerId && r.requesterId === viewerId ? ' · _yours_' : '';
      const qual = R.qualificationsLabel(r);
      return `• ${R.slackRange(r.startTs, r.endTs)} — ${who} · ${esc(r.account)} (${r.id})${qual ? ` · ${qual}` : ''}${pending}${mine}`;
    });
    blocks.push(section(`*${day}*\n${lines.join('\n')}`));
  });
  blocks.push(context(`${items.length} reservation${items.length === 1 ? '' : 's'} · times shown in your Slack time zone · \`/fcto schedule\` for more`));
  return blocks.slice(0, 48);
}

const AVAIL_EMOJI = { free: ':large_green_circle:', partial: ':large_yellow_circle:', booked: ':red_circle:' };
const DAY_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
const dayLabel = (ts) => DAY_FMT.format(ts * 1000);

// `/fcto free <dates>`: one line per Field CTO, fully-free people first.
function availabilityBlocks(store, { from, to, title } = {}) {
  const { days, members } = R.availability(store, { from, to });
  if (!days.length) return [section('_No days in that range._')];
  const span = days.length === 1 ? dayLabel(days[0]) : `${dayLabel(days[0])} to ${dayLabel(days[days.length - 1])}`;
  const blocks = [{ type: 'header', text: plain(title || `Who's free — ${span}`) }];
  const sorted = members.slice().sort((a, b) => b.freeDays - a.freeDays || a.member.name.localeCompare(b.member.name));
  sorted.forEach(({ member, days: perDay, freeDays }) => {
    const region = REGION_LABELS[member.region] || member.region;
    const image = avatarImage(member);
    const extra = image ? { accessory: image } : {};
    if (freeDays === perDay.length) {
      blocks.push(section(`${AVAIL_EMOJI.free} *${member.name}* (${region}) — free ${perDay.length === 1 ? 'all day' : `all ${perDay.length} days`}`, extra));
      return;
    }
    const detail = perDay.map((d) => {
      if (d.status === 'free') return `${AVAIL_EMOJI.free} ${dayLabel(d.day)}`;
      const what = d.busy.map((b) => (d.status === 'booked' ? b.id : `${R.formatRangeInTz(b.startTs, b.endTs, member.tz)} ${b.id}`)).join(', ');
      return `${AVAIL_EMOJI[d.status]} ${dayLabel(d.day)} (${what})`;
    });
    const bookedDays = perDay.filter((d) => d.status === 'booked').length;
    const head = bookedDays === perDay.length ? AVAIL_EMOJI.booked : AVAIL_EMOJI.partial;
    const summary = perDay.length === 1 ? (bookedDays ? 'booked' : 'partly booked') : `${freeDays}/${perDay.length} days free`;
    blocks.push(section(`${head} *${member.name}* (${region}) — ${summary}\n${detail.join(' · ')}`, extra));
  });
  blocks.push(context(`${AVAIL_EMOJI.free} free · ${AVAIL_EMOJI.partial} partly booked · ${AVAIL_EMOJI.booked} booked (6h+) · each person's local day · approved reservations in this app only — not personal calendars · \`/fcto free oct 22-24\``));
  return blocks;
}

function rosterBlocks() {
  const now = Math.floor(Date.now() / 1000);
  const lines = getRoster().map((m) => {
    const t = R.formatInTz(now, m.tz);
    return `• ${mention(m)} — ${REGION_LABELS[m.region]} · now ${t.time} ${t.zone}${m.slackId ? '' : ' · _Slack handle not configured_'}`;
  });
  return [section(`*Field CTOs*\n${lines.join('\n')}`)];
}

const HEAT = { free: ':large_green_square:', partial: ':large_yellow_square:', booked: ':large_red_square:' };
const WEEKDAY_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' });

const QUEUE_ROWS = 5;

// Upcoming pending requests this user can act on from the App Home, soonest
// first: `total` counts all of them, `rows` shows the first QUEUE_ROWS.
function actionQueue(store, userId, now = Math.floor(Date.now() / 1000)) {
  const eligible = R.listReservations(store, { from: now, statuses: [R.STATUS.PENDING] })
    .filter((r) => (r.requestType === 'any' ? R.canReassign(r, userId) || R.canClaim(r, userId) : R.canDecide(r, userId)));
  const rows = eligible.slice(0, QUEUE_ROWS).map((r) => {
      const claim = r.requestType === 'any' && !R.canReassign(r, userId);
      const button = r.requestType === 'specific'
        ? { type: 'button', text: plain('Approve'), style: 'primary', action_id: ACTION.APPROVE, value: r.id }
        : { type: 'button', text: plain(claim ? 'Claim' : 'Assign…'), ...(claim ? { style: 'primary' } : {}), action_id: claim ? ACTION.CLAIM : ACTION.ASSIGN, value: r.id };
      const chips = qualChips(r);
      return section(`*${r.id} · ${esc(r.account)}*\n${R.describeWho(r)} · ${R.slackRange(r.startTs, r.endTs)}${chips ? `\n${chips}` : ''}`, { accessory: button });
    });
  if (eligible.length > QUEUE_ROWS) {
    rows.push(context(`+${eligible.length - QUEUE_ROWS} more waiting on you in the channel`));
  }
  return { total: eligible.length, rows };
}

function homeView(store, userId) {
  const now = Math.floor(Date.now() / 1000);
  const horizon = now + 21 * 86400;
  const upcoming = scheduleBlocks(store, { from: now, to: horizon, title: 'Next 3 weeks', viewerId: userId }).slice(1);
  const mine = R.listReservations(store, { from: now, requesterId: userId });
  const admin = R.isAdmin(userId);
  const member = R.memberBySlackId(userId);
  const week = R.availability(store, { from: now, to: now + 7 * 86400 });
  const pending = R.listReservations(store, { from: now, statuses: [R.STATUS.PENDING] });
  const booked = R.listReservations(store, { from: now, to: horizon, statuses: [R.STATUS.APPROVED] });
  const freeToday = week.members.filter((m) => m.days[0] && m.days[0].status === 'free').length;
  const queue = actionQueue(store, userId, now);

  const blocks = [
    { type: 'header', text: plain(':calendar: Field CTO reservations') },
    section(`Request a block of a Field CTO's time for an account. Requests post to the channel where ${admin ? 'you and the other admins' : 'admins and the Field CTO'} approve them.${member ? `\nYou're on the roster as *${member.name}* — you can approve requests that name you and claim open ones.` : ''}${admin ? '\nYou are an *admin*: you can approve, decline, assign and reassign any request.' : ''}`),
    {
      type: 'actions',
      elements: [
        { type: 'button', text: plain(':heavy_plus_sign: New request'), style: 'primary', action_id: ACTION.NEW_REQUEST, value: 'home' },
        { type: 'button', text: plain(':arrows_counterclockwise: Refresh'), action_id: ACTION.REFRESH_HOME, value: 'home' },
      ],
    },
    {
      type: 'section',
      fields: [
        mrkdwn(`:hourglass_flowing_sand: *Pending*\n${pending.length}`),
        mrkdwn(`:white_check_mark: *Booked, next 3 weeks*\n${booked.length}`),
        mrkdwn(`:large_green_circle: *Free today*\n${freeToday} of ${week.members.length}`),
        mrkdwn(`:raising_hand: *Waiting on you*\n${queue.total}`),
      ],
    },
  ];
  if (queue.total) {
    blocks.push({ type: 'divider' }, { type: 'header', text: plain(':inbox_tray: Needs your action') }, ...queue.rows);
  }
  blocks.push({ type: 'divider' }, { type: 'header', text: plain(':world_map: The week at a glance') });
  const dayNames = week.days.map((d) => WEEKDAY_FMT.format(d * 1000).slice(0, 2)).join(' ');
  week.members.forEach(({ member: m, days }) => {
    const t = R.formatInTz(now, m.tz);
    const image = avatarImage(m);
    blocks.push(section(
      `*${m.slackId ? `<@${m.slackId}>` : m.name}* · ${REGION_LABELS[m.region]} · :clock3: ${t.time} ${t.zone}${m.slackId ? '' : ' · _Slack handle not configured_'}\n${days.map((d) => HEAT[d.status]).join('')}`,
      image ? { accessory: image } : {},
    ));
  });
  blocks.push(context(`Next 7 days (${dayNames}) · ${HEAT.free} free · ${HEAT.partial} partly booked · ${HEAT.booked} booked 6h+ · \`/fcto free <dates>\` for detail`));
  const freeAll = week.members.filter((m) => m.freeDays === m.days.length).map((m) => m.member.name);
  blocks.push(section(`*Free for the next 7 days:* ${freeAll.length ? freeAll.join(', ') : '_nobody is fully free_'}`));
  blocks.push({ type: 'divider' }, { type: 'header', text: plain(':spiral_calendar_pad: Upcoming reservations') }, ...upcoming);
  if (mine.length) {
    blocks.push({ type: 'divider' });
    blocks.push(section(`*Your open requests*\n${mine.map((r) => `• ${STATUS_META[r.status].emoji} ${r.id} · ${esc(r.account)} · ${R.describeWho(r)} · ${R.slackRange(r.startTs, r.endTs)} · ${STATUS_META[r.status].label}`).join('\n')}`));
  }
  blocks.push(context(`Admins: ${getAdminIds().map((id) => `<@${id}>`).join(', ') || '_none configured_'} · \`/fcto help\` for commands`));
  return { type: 'home', blocks: blocks.slice(0, 100) };
}

const WHO_LABEL = (who) => {
  if (who.startsWith('MEMBER:')) {
    const m = findMember(who.slice('MEMBER:'.length));
    return m ? m.name : who;
  }
  return R.PREFERENCES[who.slice('ANY:'.length)] || who;
};

// `/fcto guide`: who to use for what and what a request needs. Text lives in
// config/fcto-guide.js; routing comes from config/fcto-qualifications.js.
function guideBlocks() {
  const now = Math.floor(Date.now() / 1000);
  const reviewers = G.speakingReviewerIds().map((id) => `<@${id}>`).join(', ') || 'an admin';
  const blocks = [
    { type: 'header', text: plain(':compass: Which Field CTO, and how to ask') },
    section(`*Before you request*\n${G.BEFORE_YOU_ASK.map((x) => `• ${esc(x)}`).join('\n')}`),
    section([
      '*Two request types*',
      `• ${G.KIND.MEETING.emoji} *${G.KIND.MEETING.label}*: the Field CTO you name reviews it, or any Field CTO claims an open one. Admins can also approve.`,
      `• ${G.KIND.SPEAKING.emoji} *${G.KIND.SPEAKING.label}*: conference, panel, podcast or webinar. Approved by ${reviewers}.`,
    ].join('\n')),
    section(`*Default picks* (the form pre-selects these; you can change them)\n${Q.ROUTING_RULES.map((r) => `• ${r.reason} → ${WHO_LABEL(r.who)}`).join('\n')}`),
    { type: 'divider' },
  ];
  getRoster().forEach((m) => {
    const t = R.formatInTz(now, m.tz);
    const image = avatarImage(m);
    const focus = G.FOCUS[m.key] ? `\n${esc(G.FOCUS[m.key])}` : '';
    blocks.push(section(`*${mention(m)}* · ${REGION_LABELS[m.region]} · :clock3: ${t.time} ${t.zone}${focus}`, image ? { accessory: image } : {}));
  });
  blocks.push(context('Start a request with `/fcto request`. See who is free with `/fcto free next week`.'));
  return blocks;
}

function helpText() {
  return [
    '*Field CTO reservations*',
    '• `/fcto request` — open the request form (or `/fcto` alone)',
    '• `/fcto guide` — which Field CTO to ask for what, and what a request needs',
    '• `/fcto schedule` — this week · `/fcto schedule next` — next week · `/fcto schedule month`',
    '• `/fcto schedule @person` — one Field CTO\'s reservations · `/fcto schedule me` — your requests',
    '• `/fcto free oct 22` · `/fcto free oct 22-24` · `/fcto free next week` — who has no approved reservation on those days',
    '• `/fcto calendar` · `/fcto calendar next week` · `/fcto calendar oct 22-28` — post an availability calendar image to the channel (up to 14 days)',
    '• `/fcto roster` — who the Field CTOs are and their current local time',
    'Approve / Decline / Claim / Reassign happen on the request card in the channel. Admins and the named Field CTO can act; everyone else gets a polite no.',
  ].join('\n');
}

module.exports = {
  esc,
  availabilityBlocks,
  CALLBACK,
  ACTION,
  STATUS_META,
  requestModal,
  readRequestModal,
  whoBlockIdFor,
  modalErrors,
  declineModal,
  readDeclineModal,
  assignModal,
  readAssignModal,
  LINK_ACTIONS,
  requestCard,
  requestCardMessage,
  cardText,
  threadNote,
  threadBlocks,
  scheduleBlocks,
  rosterBlocks,
  homeView,
  helpText,
  guideBlocks,
  mention,
};
