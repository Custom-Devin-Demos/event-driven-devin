'use strict';

// Minimal RFC 5545 calendar invite for an approved Field CTO reservation.
// Posted into Slack as a file so both parties can add the block to whatever
// calendar they use — no calendar API required.

const { findMember, EMAIL_RE } = require('../../../config/fcto-roster');
const avatars = require('./avatars');
const { qualificationsLabel } = require('./reservations');

function icsDate(ts) {
  return new Date(ts * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function escapeText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/[,;]/g, (c) => `\\${c}`);
}

function foldLine(line) {
  const out = [];
  let rest = line;
  while (rest.length > 73) {
    out.push(rest.slice(0, 73));
    rest = ` ${rest.slice(73)}`;
  }
  out.push(rest);
  return out.join('\r\n');
}

function eventText(reservation) {
  const member = findMember(reservation.assigneeKey);
  const summary = `Field CTO: ${member ? member.name : 'Field CTO'} — ${reservation.account}`;
  const descriptionParts = [
    `Field CTO reservation ${reservation.id}`,
    `Account: ${reservation.account}`,
    `${{ speaking: 'Talk', meeting: 'Meeting goal' }[reservation.kind] || 'Purpose'}: ${reservation.purpose}`,
  ];
  if (reservation.attendees) descriptionParts.push(`Key attendees: ${reservation.attendees}`);
  if (reservation.opportunityUrl) descriptionParts.push(`Salesforce opportunity: ${reservation.opportunityUrl}`);
  if (reservation.eventUrl) descriptionParts.push(`Event: ${reservation.eventUrl}`);
  const qualifications = qualificationsLabel(reservation);
  if (qualifications) descriptionParts.push(`Audience / country / industry: ${qualifications}`);
  if (reservation.notes) descriptionParts.push(`Notes: ${reservation.notes}`);
  if (reservation.meetingLink) descriptionParts.push(`Meeting link: ${reservation.meetingLink}`);
  descriptionParts.push(`Requested in Slack #exec-field-requests by <@${reservation.requesterId}>`);
  return { summary, description: descriptionParts.join('\n') };
}

// The assigned Field CTO, invited as a guest when an email is known.
function invitees(reservation) {
  const member = findMember(reservation.assigneeKey);
  if (!member) return [];
  const email = member.email || avatars.getEmail(member.slackId);
  return email && EMAIL_RE.test(email) ? [{ name: member.name, email }] : [];
}

// Slack rejects a whole message whose button URL is over 3,000 characters.
const MAX_BUTTON_URL = 3000;

// Shortens `details` (by code point, so encoding never sees a lone surrogate)
// until the URL fits; drops the location and trims the title as a last resort.
function fitUrl(build, summary, details, location) {
  const chars = Array.from(details);
  const url = build(summary, details, location);
  if (url.length <= MAX_BUTTON_URL) return url;
  const prefix = (n) => (n ? `${chars.slice(0, n).join('')}…` : '');
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (build(summary, prefix(mid), location).length <= MAX_BUTTON_URL) lo = mid;
    else hi = mid - 1;
  }
  const fitted = build(summary, prefix(lo), location);
  if (fitted.length <= MAX_BUTTON_URL) return fitted;
  return build(Array.from(summary).slice(0, 120).join(''), '', '');
}

// One-click "add to calendar" links (no calendar API): each opens a prefilled
// new-event form in the clicker's own Google or Outlook calendar.
function calendarLinks(reservation) {
  const { summary, description } = eventText(reservation);
  const guests = invitees(reservation).map((g) => g.email).join(',');
  const iso = (ts) => new Date(ts * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const q = (params) => Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const google = (text, details, location) => `https://calendar.google.com/calendar/render?${q({
    action: 'TEMPLATE',
    text,
    dates: `${icsDate(reservation.startTs)}/${icsDate(reservation.endTs)}`,
    details,
    location,
    add: guests,
  })}`;
  const outlook = (subject, body, location) => `https://outlook.office.com/calendar/0/deeplink/compose?${q({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject,
    to: guests,
    startdt: iso(reservation.startTs),
    enddt: iso(reservation.endTs),
    body,
    location,
  })}`;
  const location = reservation.meetingLink || '';
  return {
    google: fitUrl(google, summary, description, location),
    outlook: fitUrl(outlook, summary, description, location),
  };
}

function buildIcs(reservation, { host = 'devindemos.com', now = Math.floor(Date.now() / 1000), attendees = invitees(reservation) } = {}) {
  const { summary, description } = eventText(reservation);

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//Cognition//Field CTO Reservations//EN`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${reservation.id.toLowerCase()}-${reservation.createdAt}@${host}`,
    `DTSTAMP:${icsDate(now)}`,
    `DTSTART:${icsDate(reservation.startTs)}`,
    `DTEND:${icsDate(reservation.endTs)}`,
    `SUMMARY:${escapeText(summary)}`,
    `DESCRIPTION:${escapeText(description)}`,
  ];
  if (reservation.meetingLink) lines.push(`URL:${reservation.meetingLink}`);
  if (reservation.meetingLink) lines.push(`LOCATION:${escapeText(reservation.meetingLink)}`);
  attendees.filter(Boolean).forEach((attendee) => {
    const { name, email } = typeof attendee === 'string' ? { name: attendee, email: attendee } : attendee;
    lines.push(`ATTENDEE;CN=${escapeText(name || email).replace(/[:"]/g, '')};ROLE=REQ-PARTICIPANT:mailto:${email}`);
  });
  lines.push('STATUS:CONFIRMED', 'TRANSP:OPAQUE', 'END:VEVENT', 'END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

function icsFilename(reservation) {
  const member = findMember(reservation.assigneeKey);
  const who = member ? member.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'field-cto';
  const day = new Date(reservation.startTs * 1000).toISOString().slice(0, 10);
  return `${reservation.id.toLowerCase()}-${who}-${day}.ics`;
}

module.exports = { buildIcs, icsFilename, icsDate, escapeText, calendarLinks, invitees, MAX_BUTTON_URL };
