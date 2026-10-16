'use strict';

// Minimal RFC 5545 calendar invite for an approved Field CTO reservation.
// Posted into Slack as a file so both parties can add the block to whatever
// calendar they use — no calendar API required.

const { findMember } = require('../../../config/fcto-roster');
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
    `Purpose: ${reservation.purpose}`,
  ];
  const qualifications = qualificationsLabel(reservation);
  if (qualifications) descriptionParts.push(`Audience / country / industry: ${qualifications}`);
  if (reservation.notes) descriptionParts.push(`Notes: ${reservation.notes}`);
  if (reservation.meetingLink) descriptionParts.push(`Meeting link: ${reservation.meetingLink}`);
  descriptionParts.push(`Requested in Slack #exec-field-requests by <@${reservation.requesterId}>`);
  return { summary, description: descriptionParts.join('\n') };
}

// One-click "add to calendar" links (no calendar API): each opens a prefilled
// new-event form in the clicker's own Google or Outlook calendar.
function calendarLinks(reservation) {
  const { summary, description } = eventText(reservation);
  const details = description.slice(0, 1200);
  const iso = (ts) => new Date(ts * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const q = (params) => Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return {
    google: `https://calendar.google.com/calendar/render?${q({
      action: 'TEMPLATE',
      text: summary,
      dates: `${icsDate(reservation.startTs)}/${icsDate(reservation.endTs)}`,
      details,
      location: reservation.meetingLink,
    })}`,
    outlook: `https://outlook.office.com/calendar/0/deeplink/compose?${q({
      path: '/calendar/action/compose',
      rru: 'addevent',
      subject: summary,
      startdt: iso(reservation.startTs),
      enddt: iso(reservation.endTs),
      body: details,
      location: reservation.meetingLink,
    })}`,
  };
}

function buildIcs(reservation, { host = 'devindemos.com', now = Math.floor(Date.now() / 1000), attendees = [] } = {}) {
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
  attendees.filter(Boolean).forEach((email) => {
    lines.push(`ATTENDEE;CN=${escapeText(email)};ROLE=REQ-PARTICIPANT:mailto:${email}`);
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

module.exports = { buildIcs, icsFilename, icsDate, escapeText, calendarLinks };
