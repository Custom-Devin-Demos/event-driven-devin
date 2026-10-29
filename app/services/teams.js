const axios = require('axios');

/**
 * Microsoft Teams delivery for demo alerts via a Teams Workflows
 * "Post to a channel when a webhook request is received" URL. The workflow
 * posts the Adaptive Card it receives into the configured channel.
 */

const ADAPTIVE_CARD_CONTENT_TYPE = 'application/vnd.microsoft.card.adaptive';

function buildTeamsAlertCard({
  title, facts, monitorQuery, codeTitle = 'Monitor query', body = [], actions = [], color = 'Attention', footer,
}) {
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    msteams: { width: 'Full' },
    body: [
      {
        type: 'TextBlock',
        text: title,
        weight: 'Bolder',
        size: 'Medium',
        color,
        wrap: true,
      },
      {
        type: 'FactSet',
        facts: facts
          .filter((f) => f && f[1])
          .map(([label, value]) => ({ title: label, value: String(value) })),
      },
      ...(monitorQuery ? [
        { type: 'TextBlock', text: codeTitle, weight: 'Bolder', spacing: 'Medium' },
        { type: 'TextBlock', text: monitorQuery, fontType: 'Monospace', wrap: true },
      ] : []),
      ...body.filter(Boolean).map((text) => ({ type: 'TextBlock', text, wrap: true, spacing: 'Small' })),
      // Teams hands responders only the card's top-level TextBlocks (FactSet rows
      // are dropped), so anything a responder must match on goes in the footer.
      ...(footer ? [{
        type: 'TextBlock', text: footer, size: 'Small', isSubtle: true, wrap: true, spacing: 'Small',
      }] : []),
    ],
    actions: actions
      .filter((a) => a && a.url)
      .map(({ title: actionTitle, url }) => ({ type: 'Action.OpenUrl', title: actionTitle, url })),
  };
}

function fieldBlock([label, value, opts = {}]) {
  return {
    type: 'Column',
    width: 'stretch',
    items: [
      { type: 'TextBlock', text: label, weight: 'Bolder', wrap: true },
      {
        type: 'TextBlock', text: String(value), wrap: true, spacing: 'None', ...(opts.mono ? { fontType: 'Monospace' } : {}),
      },
    ],
  };
}

/**
 * Slack-style alert card: two fields per row, an optional full-width code
 * block between rows, buttons, then a small footer line.
 */
function buildTeamsFieldCard({
  title, sections, actions = [], footer, color = 'Attention',
}) {
  const body = [{
    type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', color, wrap: true,
  }];
  sections.filter(Boolean).forEach((section) => {
    if (section.note) {
      body.push({ type: 'TextBlock', text: section.note.label, weight: 'Bolder', spacing: 'Medium' });
      body.push({
        type: 'TextBlock', text: section.note.text, wrap: true, spacing: 'Small',
      });
      return;
    }
    if (section.code) {
      body.push({ type: 'TextBlock', text: section.code.label, weight: 'Bolder', spacing: 'Medium' });
      // Top-level, not in a Container: Teams passes responders only top-level TextBlocks.
      body.push({
        type: 'TextBlock', text: section.code.text, fontType: 'Monospace', wrap: true, spacing: 'Small',
      });
      return;
    }
    const fields = section.fields.filter((f) => f && f[1]);
    for (let i = 0; i < fields.length; i += 2) {
      body.push({ type: 'ColumnSet', spacing: 'Medium', columns: fields.slice(i, i + 2).map(fieldBlock) });
    }
  });
  const buttons = actions.filter((a) => a && a.url)
    .map(({ title: actionTitle, url }) => ({ type: 'Action.OpenUrl', title: actionTitle, url }));
  if (buttons.length) body.push({ type: 'ActionSet', spacing: 'Medium', actions: buttons });
  if (footer) {
    body.push({
      type: 'TextBlock', text: footer, size: 'Small', isSubtle: true, wrap: true, spacing: 'Small',
    });
  }
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    msteams: { width: 'Full' },
    body,
    actions: [],
  };
}

/**
 * Amazon CloudWatch alarm notification as an Adaptive Card, laid out like the
 * SNS "ALARM: ... in <region>" message (Alarm Details / Threshold / Monitored
 * Metric / State Change Actions) with the triggering log event and the
 * responder directive appended. `cw` is the service-owned alarm definition.
 */
function buildTeamsCloudWatchAlarmCard({
  cw, logEvent, instructions, instructionsLabel = 'Responder instructions', actions = [], footer,
}) {
  const timestamp = cw.timestamp || new Date().toISOString();
  const dimensions = Object.entries(cw.dimensions || {}).map(([k, v]) => `[${k} = ${v}]`).join(' ');
  const period = `${cw.period || 60} seconds`;
  const threshold = `The alarm is in the ALARM state when the metric is ${cw.comparison || 'GreaterThanOrEqualToThreshold'} `
    + `${Number(cw.threshold ?? 1).toFixed(1)} for at least ${cw.datapoints || 1} of ${cw.evaluationPeriods || 1} datapoints within ${period}.`;
  const facts = (rows) => ({
    type: 'FactSet',
    facts: rows.filter((r) => r && r[1] !== undefined && r[1] !== null && r[1] !== '')
      .map(([title, value]) => ({ title, value: String(value) })),
  });
  const heading = (text) => ({
    type: 'TextBlock', text, weight: 'Bolder', spacing: 'Medium',
  });
  const body = [
    {
      type: 'TextBlock',
      text: `\u{1F534} ALARM: "${cw.alarmName}" in ${cw.regionLabel || cw.region}`,
      weight: 'Bolder',
      size: 'Medium',
      color: 'Attention',
      wrap: true,
    },
    {
      type: 'TextBlock',
      text: `You are receiving this message because your Amazon CloudWatch Alarm "${cw.alarmName}" in the ${cw.regionLabel || cw.region} region has entered the ALARM state, because "${cw.reason}" at "${timestamp}".`,
      wrap: true,
      isSubtle: true,
      spacing: 'Small',
    },
    heading('Alarm Details'),
    facts([
      ['Name', cw.alarmName],
      ['Description', cw.alarmDescription],
      ['State Change', `${cw.previousState || 'OK'} -> ALARM`],
      ['Reason for State Change', cw.reason],
      ['Timestamp', timestamp],
      ['AWS Account', cw.accountId],
      ['Alarm Arn', `arn:aws:cloudwatch:${cw.region}:${cw.accountId}:alarm:${cw.alarmName}`],
    ]),
    heading('Threshold'),
    { type: 'TextBlock', text: threshold, wrap: true, spacing: 'Small' },
    heading('Monitored Metric'),
    facts([
      ['MetricNamespace', cw.namespace],
      ['MetricName', cw.metricName],
      ['Dimensions', dimensions],
      ['Period', period],
      ['Statistic', cw.statistic || 'Sum'],
      ['Unit', cw.unit || 'not specified'],
      ['TreatMissingData', cw.treatMissingData || 'notBreaching'],
    ]),
    heading('State Change Actions'),
    facts([
      ['OK', cw.okAction || ''],
      ['ALARM', cw.alarmAction || `[arn:aws:sns:${cw.region}:${cw.accountId}:${cw.snsTopic || 'oncall-alerts'}]`],
      ['INSUFFICIENT_DATA', cw.insufficientDataAction || ''],
    ]),
  ];
  if (logEvent) {
    body.push(heading(`Triggering log event (${cw.logGroup || 'CloudWatch Logs'})`));
    // Top-level, not in a Container: Teams passes responders only top-level TextBlocks.
    body.push({
      type: 'TextBlock', text: logEvent, fontType: 'Monospace', wrap: true, spacing: 'Small',
    });
  }
  if (instructions) {
    body.push(heading(instructionsLabel));
    body.push({
      type: 'TextBlock', text: instructions, wrap: true, spacing: 'Small',
    });
  }
  const buttons = actions.filter((a) => a && a.url)
    .map(({ title, url }) => ({ type: 'Action.OpenUrl', title, url }));
  if (buttons.length) body.push({ type: 'ActionSet', spacing: 'Medium', actions: buttons });
  if (footer) {
    body.push({
      type: 'TextBlock', text: footer, size: 'Small', isSubtle: true, wrap: true, spacing: 'Small',
    });
  }
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    msteams: { width: 'Full' },
    body,
    actions: [],
  };
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Plain-text (HTML) rendering of a card for Workflows that post a message instead of
// the card: Teams responders can't read Adaptive Card contents.
function teamsCardText(card) {
  const lines = [];
  const linkOf = (a) => `<a href="${escapeHtml(a.url)}">${escapeHtml(a.title)}</a>`;
  const walk = (block) => {
    if (block.type === 'FactSet') {
      block.facts.forEach((f) => lines.push(`<b>${escapeHtml(f.title)}:</b> ${escapeHtml(f.value)}`));
    } else if (block.type === 'ColumnSet') {
      block.columns.forEach((col) => {
        const [label, value] = col.items;
        lines.push(`<b>${escapeHtml(label.text)}:</b> ${escapeHtml(value.text)}`);
      });
    } else if (block.type === 'Container') {
      block.items.forEach(walk);
    } else if (block.type === 'ActionSet') {
      block.actions.forEach((a) => lines.push(linkOf(a)));
    } else if (block.fontType === 'Monospace') {
      lines.push(`<code>${escapeHtml(block.text)}</code>`);
    } else if (block.weight === 'Bolder') {
      lines.push(`<b>${escapeHtml(block.text)}</b>`);
    } else {
      lines.push(escapeHtml(block.text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>'));
    }
  };
  card.body.forEach(walk);
  (card.actions || []).forEach((a) => lines.push(linkOf(a)));
  return lines.join('<br>');
}

// Teams Workflow / Power Automate / legacy incoming-webhook hosts. A hub user
// can supply their own webhook URL, so anything else is refused to keep the
// server from POSTing to arbitrary destinations.
const TEAMS_WEBHOOK_HOST_SUFFIXES = ['.logic.azure.com', '.api.powerplatform.com', '.webhook.office.com'];

function isTeamsWebhookUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
  const host = url.hostname.toLowerCase();
  return TEAMS_WEBHOOK_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
}

async function postTeamsCard(webhookUrl, card) {
  const response = await axios.post(webhookUrl, {
    type: 'message',
    text: teamsCardText(card),
    attachments: [{ contentType: ADAPTIVE_CARD_CONTENT_TYPE, contentUrl: null, content: card }],
  }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000,
    maxRedirects: 0,
  });
  return response.status;
}

module.exports = {
  buildTeamsCloudWatchAlarmCard,
  buildTeamsAlertCard, buildTeamsFieldCard, isTeamsWebhookUrl, postTeamsCard, teamsCardText,
};
