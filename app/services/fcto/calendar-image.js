'use strict';

// Renders `/fcto calendar` as a PNG: one row per Field CTO, one column per day,
// each cell in that Field CTO's own time zone with their approved bookings
// listed and drawn on an 8 AM–7 PM bar. Built as SVG and rasterized with
// resvg, using the bundled Inter fonts so output doesn't depend on host fonts.

const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const R = require('./reservations');

const MAX_CALENDAR_DAYS = 14;
const DAY = 86400;
const WORK_START = 8;
const WORK_END = 19;
const MAX_LINES = 3;
const FONT_DIR = path.join(__dirname, 'fonts');
const FONT_FILES = ['Inter-Regular.ttf', 'Inter-SemiBold.ttf', 'Inter-Bold.ttf'].map((f) => path.join(FONT_DIR, f));

const C = {
  ink: '#101828',
  muted: '#667085',
  faint: '#98A2B3',
  line: '#E4E7EC',
  bg: '#FFFFFF',
  canvas: '#F9FAFB',
  accent: '#4F46E5',
  free: { fill: '#ECFDF3', stroke: '#ABEFC6', text: '#067647' },
  partial: { fill: '#FFFAEB', stroke: '#FEDF89', text: '#B54708' },
  booked: { fill: '#FEF3F2', stroke: '#FECDCA', text: '#B42318' },
  weekend: { fill: '#F2F4F7', stroke: '#E4E7EC', text: '#667085' },
  block: '#F04438',
  track: '#E4E7EC',
};
const STATUS_TEXT = { free: 'Free', partial: 'Partly booked', booked: 'Booked' };
const AVATAR_COLORS = ['#4F46E5', '#0E9384', '#C11574', '#DC6803', '#1570EF', '#6938EF'];

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fit(text, maxChars) {
  const chars = Array.from(String(text));
  return chars.length <= maxChars ? chars.join('') : `${chars.slice(0, Math.max(1, maxChars - 1)).join('')}…`;
}

function localParts(ts, tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ts * 1000));
  const get = (t) => Number((parts.find((p) => p.type === t) || {}).value || 0);
  return { h: get('hour') % 24, m: get('minute') };
}

// "9a", "10:30a", "2p" — compact enough to fit a day cell.
function shortTime(ts, tz, isEnd = false) {
  let { h, m } = localParts(ts, tz);
  if (isEnd && h === 0 && m === 0) h = 24;
  const suffix = h < 12 || h === 24 ? 'a' : 'p';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m ? `:${String(m).padStart(2, '0')}` : ''}${suffix}`;
}

const ZONE_FALLBACK = { 'Asia/Tokyo': 'JST', 'Asia/Seoul': 'KST', 'Asia/Singapore': 'SGT', 'Asia/Kolkata': 'IST' };

// US English names US zones (PDT), UK English names European ones (CEST, BST).
function zoneLabel(tz, at) {
  const name = (locale) => {
    const p = new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date(at * 1000));
    return (p.find((x) => x.type === 'timeZoneName') || {}).value || '';
  };
  const label = [name('en-US'), name('en-GB')].find((n) => n && !n.startsWith('GMT') && !n.startsWith('UTC'));
  return label || ZONE_FALLBACK[tz] || name('en-GB') || tz;
}

// One abbreviation per row; if the range crosses a DST change, name both and
// the first date on the new offset, e.g. "CEST → CET Oct 25".
function rowZoneLabel(tz, cells) {
  const first = zoneLabel(tz, cells[0].startTs + 12 * 3600);
  const change = cells.find((c) => zoneLabel(tz, c.startTs + 12 * 3600) !== first);
  if (!change) return first;
  const on = new Date(change.day * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${first} → ${zoneLabel(tz, change.startTs + 12 * 3600)} ${on}`;
}

function dayLabel(d) {
  const date = new Date(d * 1000);
  return {
    weekday: date.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
    date: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
    weekend: [0, 6].includes(date.getUTCDay()),
  };
}

// "Oct 19 – Oct 25, 2026" for the UTC day bounds [from, to).
function rangeTitle(from, to) {
  const opts = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  const a = new Date(from * 1000).toLocaleDateString('en-US', opts);
  const b = new Date((to - DAY) * 1000).toLocaleDateString('en-US', { ...opts, year: 'numeric' });
  return to - from <= DAY ? b : `${a} – ${b}`;
}

function initials(name) {
  return name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
}

/**
 * SVG for the availability of [from, to) (UTC day bounds, ≤ 14 days).
 * Only approved reservations count, like `/fcto free`.
 */
function calendarSvg(store, { from, to, now = Math.floor(Date.now() / 1000), env = process.env }) {
  const { days, members } = R.availability(store, { from, to, env });
  const pad = 32;
  const nameW = 220;
  const dayW = days.length <= 7 ? 172 : 136;
  const headerH = 66;
  const dayHdrH = 46;
  const lineH = 17;
  const rows = members.map((m) => {
    const lines = Math.min(MAX_LINES + 1, Math.max(1, ...m.days.map((d) => (d.busy.length > MAX_LINES ? MAX_LINES + 1 : d.busy.length))));
    return { ...m, height: 52 + lines * lineH };
  });
  const gridW = nameW + days.length * dayW;
  const width = pad * 2 + gridW;
  const gridTop = pad + headerH;
  const bodyTop = gridTop + dayHdrH;
  const bodyH = rows.reduce((n, r) => n + r.height, 0);
  const footerTop = bodyTop + bodyH + 20;
  const height = footerTop + 40 + pad;
  const today = Math.floor(now / DAY) * DAY;
  const charW = 6.4;
  const out = [];

  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Inter">`);
  out.push(`<rect width="${width}" height="${height}" fill="${C.canvas}"/>`);
  out.push(`<rect x="${pad - 12}" y="${pad - 12}" width="${gridW + 24}" height="${height - 2 * pad + 24}" rx="16" fill="${C.bg}" stroke="${C.line}"/>`);
  out.push(`<rect x="${pad}" y="${pad + 2}" width="6" height="40" rx="3" fill="${C.accent}"/>`);
  out.push(`<text x="${pad + 18}" y="${pad + 22}" font-size="22" font-weight="700" fill="${C.ink}">Field CTO availability</text>`);
  out.push(`<text x="${pad + 18}" y="${pad + 44}" font-size="14" fill="${C.muted}">${esc(rangeTitle(days[0], days[days.length - 1] + DAY))} · each row in that Field CTO's local time · bars show ${WORK_START} AM – ${WORK_END - 12} PM</text>`);

  days.forEach((d, i) => {
    const x = pad + nameW + i * dayW;
    const l = dayLabel(d);
    const isToday = d === today;
    if (isToday) out.push(`<rect x="${x + 4}" y="${gridTop + 4}" width="${dayW - 8}" height="${dayHdrH - 8}" rx="8" fill="#EEF4FF"/>`);
    out.push(`<text x="${x + dayW / 2}" y="${gridTop + 21}" text-anchor="middle" font-size="12" font-weight="600" fill="${isToday ? C.accent : C.muted}">${esc(l.weekday.toUpperCase())}${isToday ? ' · TODAY' : ''}</text>`);
    out.push(`<text x="${x + dayW / 2}" y="${gridTop + 37}" text-anchor="middle" font-size="14" font-weight="600" fill="${isToday ? C.accent : C.ink}">${esc(l.date)}</text>`);
  });
  out.push(`<line x1="${pad}" y1="${bodyTop}" x2="${pad + gridW}" y2="${bodyTop}" stroke="${C.line}"/>`);

  let y = bodyTop;
  rows.forEach((row, ri) => {
    const { member } = row;
    const cy = y + row.height / 2;
    out.push(`<circle cx="${pad + 20}" cy="${cy}" r="18" fill="${AVATAR_COLORS[ri % AVATAR_COLORS.length]}"/>`);
    out.push(`<text x="${pad + 20}" y="${cy + 5}" text-anchor="middle" font-size="13" font-weight="700" fill="#FFFFFF">${esc(initials(member.name))}</text>`);
    out.push(`<text x="${pad + 48}" y="${cy - 3}" font-size="15" font-weight="600" fill="${C.ink}">${esc(fit(member.name, 20))}</text>`);
    const region = R.REGION_LABELS[member.region] || member.region;
    out.push(`<text x="${pad + 48}" y="${cy + 15}" font-size="12" fill="${C.muted}">${esc(fit(`${rowZoneLabel(member.tz, row.days)} · ${region}`, 24))}</text>`);

    row.days.forEach((cell, di) => {
      const x = pad + nameW + di * dayW + 5;
      const w = dayW - 10;
      const top = y + 5;
      const h = row.height - 10;
      const weekendFree = cell.status === 'free' && dayLabel(cell.day).weekend;
      const tone = weekendFree ? C.weekend : C[cell.status];
      out.push(`<rect x="${x}" y="${top}" width="${w}" height="${h}" rx="9" fill="${tone.fill}" stroke="${tone.stroke}"/>`);
      out.push(`<circle cx="${x + 13}" cy="${top + 15}" r="4" fill="${tone.text}"/>`);
      out.push(`<text x="${x + 22}" y="${top + 19}" font-size="12" font-weight="600" fill="${tone.text}">${weekendFree ? 'Weekend' : STATUS_TEXT[cell.status]}</text>`);
      const maxChars = Math.floor((w - 20) / charW);
      const shown = cell.busy.length > MAX_LINES ? cell.busy.slice(0, MAX_LINES - 1) : cell.busy;
      shown.forEach((b, bi) => {
        const label = `${shortTime(b.startTs, member.tz)}–${shortTime(b.endTs, member.tz, true)} ${b.account}`;
        out.push(`<text x="${x + 10}" y="${top + 38 + bi * lineH}" font-size="12" fill="${C.ink}">${esc(fit(label, maxChars))}</text>`);
      });
      if (shown.length < cell.busy.length) {
        out.push(`<text x="${x + 10}" y="${top + 38 + shown.length * lineH}" font-size="12" fill="${C.muted}">+${cell.busy.length - shown.length} more</text>`);
      }
      const barX = x + 10;
      const barW = w - 20;
      const barY = top + h - 13;
      const winStart = R.localDayStart(cell.day + WORK_START * 3600, member.tz);
      const winEnd = R.localDayStart(cell.day + WORK_END * 3600, member.tz);
      out.push(`<rect x="${barX}" y="${barY}" width="${barW}" height="6" rx="3" fill="${C.track}"/>`);
      cell.busy.forEach((b) => {
        const s = Math.max(b.startTs, winStart);
        const e = Math.min(b.endTs, winEnd);
        if (e <= s) return;
        const bx = barX + ((s - winStart) / (winEnd - winStart)) * barW;
        const bw = Math.max(3, ((e - s) / (winEnd - winStart)) * barW);
        out.push(`<rect x="${bx.toFixed(1)}" y="${barY}" width="${bw.toFixed(1)}" height="6" rx="3" fill="${C.block}"/>`);
      });
    });
    y += row.height;
    out.push(`<line x1="${pad}" y1="${y}" x2="${pad + gridW}" y2="${y}" stroke="${C.line}"/>`);
  });

  let lx = pad;
  [['Free', C.free.text], ['Partly booked', C.partial.text], ['Booked (6h+)', C.booked.text], ['Booked time on the bar', C.block]].forEach(([label, color]) => {
    out.push(`<circle cx="${lx + 5}" cy="${footerTop + 10}" r="5" fill="${color}"/>`);
    out.push(`<text x="${lx + 16}" y="${footerTop + 14}" font-size="12" fill="${C.muted}">${esc(label)}</text>`);
    lx += 34 + label.length * charW;
  });
  out.push(`<text x="${pad}" y="${footerTop + 36}" font-size="12" fill="${C.faint}">Approved reservations in the Field CTO app only (not personal calendars); pending requests don't count. Request time with /fcto request.</text>`);
  out.push('</svg>');
  return out.join('');
}

function renderCalendarPng(store, opts) {
  const svg = calendarSvg(store, opts);
  const png = new Resvg(svg, {
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Inter' },
    fitTo: { mode: 'zoom', value: 2 },
  }).render().asPng();
  return Buffer.from(png);
}

module.exports = { MAX_CALENDAR_DAYS, calendarSvg, renderCalendarPng, rangeTitle };
