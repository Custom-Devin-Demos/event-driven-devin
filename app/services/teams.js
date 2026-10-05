const axios = require('axios');

/**
 * Microsoft Teams delivery for On-Call alerts via a Teams Workflows
 * "Post to a channel when a webhook request is received" URL. The workflow
 * posts the Adaptive Card it receives into the configured channel.
 */

const ADAPTIVE_CARD_CONTENT_TYPE = 'application/vnd.microsoft.card.adaptive';

function buildTeamsAlertCard({ title, facts, monitorQuery, body, actions }) {
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
        color: 'Attention',
        wrap: true,
      },
      {
        type: 'FactSet',
        facts: facts
          .filter((f) => f && f[1])
          .map(([label, value]) => ({ title: label, value: String(value) })),
      },
      ...(monitorQuery ? [
        { type: 'TextBlock', text: 'Monitor query', weight: 'Bolder', spacing: 'Medium' },
        { type: 'TextBlock', text: monitorQuery, fontType: 'Monospace', wrap: true },
      ] : []),
      ...body.filter(Boolean).map((text) => ({ type: 'TextBlock', text, wrap: true, spacing: 'Small' })),
    ],
    actions: actions
      .filter((a) => a && a.url)
      .map(({ title: actionTitle, url }) => ({ type: 'Action.OpenUrl', title: actionTitle, url })),
  };
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Plain-text (HTML) rendering of a card for Workflows that post a message instead of
// the card: Teams responders can't read Adaptive Card contents.
function teamsCardText(card) {
  const lines = [];
  card.body.forEach((block) => {
    if (block.type === 'FactSet') {
      block.facts.forEach((f) => lines.push(`<b>${escapeHtml(f.title)}:</b> ${escapeHtml(f.value)}`));
    } else if (block.fontType === 'Monospace') {
      lines.push(`<code>${escapeHtml(block.text)}</code>`);
    } else if (block.weight === 'Bolder') {
      lines.push(`<b>${escapeHtml(block.text)}</b>`);
    } else {
      lines.push(escapeHtml(block.text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>'));
    }
  });
  (card.actions || []).forEach((a) => lines.push(`<a href="${escapeHtml(a.url)}">${escapeHtml(a.title)}</a>`));
  return lines.join('<br>');
}

async function postTeamsCard(webhookUrl, card) {
  const response = await axios.post(webhookUrl, {
    type: 'message',
    text: teamsCardText(card),
    attachments: [{ contentType: ADAPTIVE_CARD_CONTENT_TYPE, contentUrl: null, content: card }],
  }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000,
  });
  return response.status;
}

module.exports = { buildTeamsAlertCard, postTeamsCard, teamsCardText };
