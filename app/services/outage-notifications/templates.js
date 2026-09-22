/**
 * Email copy deck for the Lumen proactive circuit outage notification service.
 *
 * All copy lives in the TEMPLATES string table keyed by template id and line,
 * localization-ready per YD-3 §5: sentences are never concatenated, variables
 * are interpolated as whole tokens ({name}), and {state} is inserted as a whole
 * word with its own translation key (STATE_WORDS).
 *
 * Copy is verbatim from YD-3 §2.1 / §2.2.
 */

const STATE_WORDS = {
  down: 'Down',
  degraded: 'Degraded',
  restored: 'Restored',
  intermittent: 'Intermittent',
  closed: 'Closed - no outage',
};

const STATE_GLYPHS = {
  down: '⯃',
  degraded: '▲',
  restored: '✓',
  intermittent: '〜',
  closed: '—',
};

// Light-mode state band tint/text pairs from YD-3 §5 (all above 7:1 contrast).
const STATE_COLORS = {
  down: { band: '#FBE9E7', text: '#7A1C10' },
  degraded: { band: '#FFF4E0', text: '#6B4300' },
  restored: { band: '#E6F4EA', text: '#12522A' },
  intermittent: { band: '#FFF4E0', text: '#6B4300' },
  closed: { band: '#EDEDED', text: '#3D3D3D' },
};

const NO_ETA_LINE = 'Estimated restore: ETA not yet available. '
  + 'We will send an update as soon as we have one, and at most every 30 minutes.';

const COMMON_FOOTER = 'You receive this because you are an opted-in network contact for {account_name}. '
  + 'Manage notifications: {prefs_url}. Need help now: {support_phone}. '
  + 'Reference incident {incident_id} when you call.';

const SUBJECT_STEM = '[{state}] {circuit_name} ({circuit_id}) - Lumen incident {incident_id}';

/**
 * String table. `subject` may be a string or a function of vars (E3/E4 use the
 * current state word; E7 has a fixed prefix). Body lines are literal copy with
 * {variable} tokens; the pseudo-tokens {eta_line} and {impact_line} are expanded
 * by render() per the AC-6 / impact rules, and {footer} appends COMMON_FOOTER.
 */
const TEMPLATES = {
  E1: {
    id: 'E1',
    kind: 'down',
    subject: SUBJECT_STEM,
    state: 'down',
    body: [
      'Circuit down: {circuit_name} ({circuit_id}), {site_a} to {site_z}.',
      'Detected {started_at}. Our network operations centre is already working on it.',
      'Status: Down (no traffic is passing)',
      '{eta_line}',
      '{impact_line}',
      'View live status and history: {portal_url}',
      '{footer}',
    ],
  },
  E2: {
    id: 'E2',
    kind: 'degraded',
    subject: SUBJECT_STEM,
    state: 'degraded',
    body: [
      'Circuit degraded: {circuit_name} ({circuit_id}), {site_a} to {site_z}.',
      'Traffic is still passing but with reduced performance (for example packet loss, errors or reduced capacity). This is not a full outage.',
      'Detected {started_at}. Our network operations centre is investigating.',
      'Status: Degraded (traffic passing, performance reduced)',
      '{eta_line}',
      '{impact_line}',
      'If you have an alternate path, you may want to reroute critical traffic until this is resolved.',
      'View live status and history: {portal_url}',
      '{footer}',
    ],
  },
  E3: {
    id: 'E3',
    kind: 'state_change',
    subject: SUBJECT_STEM,
    // state comes from vars.state (the new state word)
    body: {
      'degraded->down': [
        'Update: {circuit_name} ({circuit_id}) has gone from degraded to down at {changed_at}. No traffic is passing.',
        'Status: Down (no traffic is passing)',
        '{eta_line}',
        'View live status and history: {portal_url}',
        '{footer}',
      ],
      'down->degraded': [
        'Update: {circuit_name} ({circuit_id}) is partially restored as of {changed_at}. Traffic is passing with reduced performance. We will confirm when it is fully restored.',
        'Status: Degraded (traffic passing, performance reduced)',
        '{eta_line}',
        'View live status and history: {portal_url}',
        '{footer}',
      ],
    },
  },
  E4: {
    id: 'E4',
    kind: 'eta_update',
    subject: SUBJECT_STEM,
    body: [
      'Update on {circuit_name} ({circuit_id}): the estimated restore time has changed.',
      'New estimate: {eta} (updated {eta_updated_at}). Previous estimate: {previous_eta}.',
      'Status: {state}',
      'Recent updates:',
      '{update_history}',
      'Full history: {portal_url}',
      '{footer}',
    ],
  },
  E5: {
    id: 'E5',
    kind: 'restored',
    subject: SUBJECT_STEM,
    state: 'restored',
    body: [
      'Restored: {circuit_name} ({circuit_id}) is carrying traffic normally again as of {restored_at}.',
      'Outage duration: {duration} (from {started_at}).',
      'Status: Restored',
      '{impact_line}',
      'If you are still seeing problems on this circuit, call {support_phone} and reference incident {incident_id}.',
      'Incident history: {portal_url}',
      '{footer}',
    ],
  },
  E6: {
    id: 'E6',
    kind: 'intermittent',
    subject: SUBJECT_STEM,
    state: 'intermittent',
    body: [
      '{circuit_name} ({circuit_id}) has gone down and come back {count} times since {started_at}. We are treating this as one intermittent incident and have paused individual down and restored messages for it.',
      'Status: Intermittent (service unstable)',
      '{eta_line}',
      'What has happened so far:',
      '{update_history}',
      'You will get one message when the circuit has been stable for 15 minutes, or sooner if we have an ETA.',
      'Live status: {portal_url}',
      '{footer}',
    ],
  },
  E7: {
    id: 'E7',
    kind: 'false_alarm',
    subject: '[Resolved - no outage] {circuit_name} ({circuit_id}) - Lumen incident {incident_id}',
    state: 'closed',
    body: [
      'Correction: the earlier {previous_state} notice for {circuit_name} ({circuit_id}) sent at {started_at} was raised in error. The circuit did not experience an outage. We are sorry for the interruption.',
      'Incident {incident_id} is closed and will show as "Closed - no outage" in your portal history.',
      '{footer}',
    ],
  },
};

const DEFAULT_TIMEZONE = 'America/Los_Angeles';

/**
 * Format an ISO timestamp for customer copy: "14 Sep 2026, 09:42 PDT"
 * (day, short month, year, comma, 24h HH:mm, short tz name — YD-3 §2).
 */
function formatTimestamp(iso, timeZone = DEFAULT_TIMEZONE) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZoneName: 'short',
    }).formatToParts(date);
    const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
    return `${get('day')} ${get('month')} ${get('year')}, ${get('hour')}:${get('minute')} ${get('timeZoneName')}`;
  } catch {
    return date.toISOString();
  }
}

const SUBJECT_NAME_MAX = 40;

function truncateName(name) {
  const value = String(name == null ? '' : name);
  return value.length > SUBJECT_NAME_MAX ? `${value.slice(0, SUBJECT_NAME_MAX)}…` : value;
}

function interpolate(line, vars) {
  return line.replace(/\{([a-z_]+)\}/g, (match, key) => {
    if (key === 'eta_line' || key === 'impact_line' || key === 'footer') return match;
    if (vars[key] === undefined || vars[key] === null) return '';
    return String(vars[key]);
  });
}

function etaLine(vars) {
  if (vars.eta) return `Estimated restore: ${vars.eta}`;
  return NO_ETA_LINE;
}

function impactLine(templateId, vars) {
  if (!vars.impact) return null;
  if (templateId === 'E5') return `Cause: ${vars.impact}`;
  return `What we know: ${vars.impact}`;
}

function bodyLines(template, vars) {
  let lines = template.body;
  if (!Array.isArray(lines)) {
    const transition = `${vars.previous_state_raw || ''}->${vars.state_raw || ''}`;
    lines = lines[transition] || [];
  }
  const out = [];
  for (const line of lines) {
    if (line === '{eta_line}') {
      out.push(etaLine(vars));
    } else if (line === '{impact_line}') {
      const rendered = impactLine(template.id, vars);
      if (rendered) out.push(rendered);
    } else if (line === '{footer}') {
      out.push(interpolate(COMMON_FOOTER, vars));
    } else if (line === '{update_history}') {
      const history = String(vars.update_history || '');
      for (const h of history.split('\n')) out.push(h);
    } else {
      out.push(interpolate(line, vars));
    }
  }
  return out;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stateOf(template, vars) {
  if (vars.state_raw) return vars.state_raw;
  return template.state || 'down';
}

function renderSubject(template, vars) {
  const subjectVars = { ...vars, circuit_name: truncateName(vars.circuit_name) };
  return interpolate(template.subject, subjectVars);
}

function renderHtml(template, vars, lines) {
  const state = stateOf(template, vars);
  const word = vars.state || STATE_WORDS[state] || state;
  const colors = STATE_COLORS[state] || STATE_COLORS.down;
  const glyph = STATE_GLYPHS[state] || '';
  const portalUrl = vars.portal_url || '';
  const [headline, ...rest] = lines;
  const bodyHtml = rest
    .map((line) => `        <p style="margin:0 0 12px 0;">${escapeHtml(line)}</p>`)
    .join('\n');
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<body style="margin:0;padding:0;background:#ffffff;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">',
    '  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;font-family:Arial,Helvetica,sans-serif;color:#1A1A1A;font-size:16px;line-height:24px;">',
    '    <tr><td style="background:#0C1B33;color:#ffffff;padding:16px 24px;font-weight:bold;letter-spacing:2px;">LUMEN</td></tr>',
    `    <tr><td style="background:${colors.band};color:${colors.text};padding:12px 24px;font-weight:bold;">${escapeHtml(glyph)} ${escapeHtml(word)}</td></tr>`,
    '    <tr><td style="padding:24px;">',
    `      <h1 style="font-size:20px;line-height:28px;margin:0 0 16px 0;">${escapeHtml(headline)}</h1>`,
    bodyHtml,
    `      <p style="margin:24px 0 8px 0;"><a href="${escapeHtml(portalUrl)}" style="display:inline-block;min-height:44px;line-height:44px;padding:0 24px;background:#0075C9;color:#ffffff;text-decoration:none;border-radius:4px;font-weight:bold;">View live status</a></p>`,
    `      <p style="margin:0 0 16px 0;font-size:14px;">${escapeHtml(portalUrl)}</p>`,
    '    </td></tr>',
    '  </table>',
    '</td></tr></table>',
    '</body>',
    '</html>',
  ].join('\n');
}

/**
 * Render a notification template.
 * @param {string} templateId  E1..E7
 * @param {object} vars        Token values ({circuit_id}, {eta}, ...); plus
 *   state_raw (new state key) and previous_state_raw for E3 transitions.
 * @returns {{ subject: string, text: string, html: string }}
 */
function render(templateId, vars = {}) {
  const template = TEMPLATES[templateId];
  if (!template) throw new Error(`Unknown template: ${templateId}`);
  const merged = { state: STATE_WORDS[stateOf(template, vars)], ...vars };
  const lines = bodyLines(template, merged);
  return {
    subject: renderSubject(template, merged),
    text: lines.join('\n'),
    html: renderHtml(template, merged, lines),
  };
}

module.exports = {
  TEMPLATES,
  STATE_WORDS,
  STATE_GLYPHS,
  STATE_COLORS,
  COMMON_FOOTER,
  NO_ETA_LINE,
  DEFAULT_TIMEZONE,
  formatTimestamp,
  truncateName,
  render,
};
