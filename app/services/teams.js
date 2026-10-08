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
  sections.forEach((section) => {
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
  buildTeamsAlertCard, buildTeamsFieldCard, isTeamsWebhookUrl, postTeamsCard, teamsCardText,
};
