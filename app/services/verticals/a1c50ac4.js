/* global setImmediate */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.CUSTOMER_A1C50AC4_SLACK_MEMBER_ID || '';

const SERVICE = 'customer-a1c50ac4-publish';
const ROUTE = '/api/a1c50ac4/publish';
const TARGET_REPO = 'COG-GTM/dowjones-newsroom-wp';

// Mirrors src/Editorial/DeskRegistry.php in the target repository: keyed by the
// desk site's path, imported from the Méthode desk table (NEWS-2207). The
// Barron's row kept its legacy Méthode key, so /barrons/ has no entry.
const DESK_REGISTRY = {
  wsj: { brand: 'The Wall Street Journal', paywall: 'metered', syndication: ['apple_news', 'amp', 'factiva'] },
  'barrons-online': { brand: "Barron's", paywall: 'hard', syndication: ['apple_news', 'factiva'] },
  marketwatch: { brand: 'MarketWatch', paywall: 'free', syndication: ['apple_news', 'amp', 'yahoo_finance'] },
};

const DESKS = {
  wsj: { label: 'The Wall Street Journal', path: '/wsj/' },
  barrons: { label: "Barron's", path: '/barrons/' },
  marketwatch: { label: 'MarketWatch', path: '/marketwatch/' },
};

const QUEUE = [
  { id: 4182, desk: 'wsj', section: 'Markets', slug: 'fed-holds-rates-steady', headline: 'Fed Holds Rates Steady as Officials Weigh Tariff Pass-Through', byline: 'Nick Timiraos', words: 1140, editor: 'R. Alvarez' },
  { id: 4187, desk: 'barrons', section: 'Stock Picks', slug: 'ai-stocks-snap-back', headline: 'AI Stocks Snap Back. Why Nvidia Could Lead the Next Leg Up.', byline: 'Tae Kim', words: 980, editor: 'J. Patel' },
  { id: 4191, desk: 'marketwatch', section: 'Personal Finance', slug: 'social-security-cola-2027', headline: 'Social Security COLA for 2027: What Retirees Should Expect', byline: 'Alessandra Malito', words: 860, editor: 'K. Osei' },
  { id: 4194, desk: 'wsj', section: 'Tech', slug: 'anthropic-ipo-valuation', headline: 'Major Investors Skeptical Anthropic IPO Can Achieve $1.5 Trillion Valuation', byline: 'Berber Jin', words: 1320, editor: 'R. Alvarez' },
  { id: 4196, desk: 'barrons', section: 'Streetwise', slug: 'data-center-spend', headline: 'Big Tech Is Spending More on Data Centers Than It Makes. That Math Has to Change.', byline: 'Jack Hough', words: 1050, editor: 'J. Patel' },
];

class PhpTypeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TypeError';
  }
}

function deskForSite(path) {
  const entry = DESK_REGISTRY[String(path).replace(/^\/+|\/+$/g, '')];
  if (entry === undefined) {
    throw new PhpTypeError('DowJones\\Newsroom\\Editorial\\DeskRegistry::forSite(): Return value must be of type array, null returned');
  }
  return entry;
}

function listQueue() {
  return QUEUE.map((story) => ({ ...story, deskLabel: DESKS[story.desk].label }));
}

function buildDirective({ story, requestId }) {
  return [
    `*Repository to investigate and fix:* \`${TARGET_REPO}\` (WordPress multisite on PHP-FPM 8.3; newsroom REST API in \`src/\`, tests in \`tests/Unit/\`). Do not modify \`COG-GTM/event-driven-devin\`.`,
    '',
    `*What editors see:* "Publish" in the desk editor fails with HTTP 500 for every Barron's story; WSJ and MarketWatch stories publish normally. Barron's stories are stuck on the desk (sample: #${story.id} "${story.headline}").`,
    '',
    '*Error:* `PHP Fatal error: Uncaught TypeError: DowJones\\Newsroom\\Editorial\\DeskRegistry::forSite(): Return value must be of type array, null returned`',
    '- Endpoint: `POST /barrons/wp-json/dj/v1/articles/{id}/publish` → `DowJones\\Newsroom\\Editorial\\PublishController::handle`',
    '- Thrown in `src/Editorial/DeskRegistry.php` (`DeskRegistry::forSite`), called from `src/Editorial/PublishController.php`',
    '- Started after the release that added per-desk paywall/syndication settings (desk table imported from Méthode, NEWS-2207)',
    `- Sample request: ${requestId}, site path \`/barrons/\`, article ${story.id}`,
    '',
    '*What to do:*',
    "1. Reproduce locally: `make up && make setup` (Docker; WordPress on http://localhost, desk sites /wsj/, /barrons/, /marketwatch/), create a draft on the Barron's site and publish it through the REST route above as `deskeditor` / `newsroom-editor`, or with `docker compose run --rm -T wpcli --url=http://localhost/barrons/ eval ...`. Confirm WSJ and MarketWatch publish and Barron's fails.",
    "2. Find the root cause and fix it so every desk site resolves its settings (keep Barron's hard paywall). Make an unknown desk fail with a clear error rather than a fatal TypeError.",
    "3. Add PHPUnit coverage for all three desks and the unknown-desk case, then run `make test`.",
    '4. Re-run the publish request for all three desks on the running stack and record the before/after (screen recording or terminal capture).',
    '5. Open a pull request against `main` with the root cause, the fix, the test output and the before/after evidence.',
  ].join('\n');
}

function reportPublishFailure({ requestId, durationMs, story, error, data }) {
  Sentry.captureException(error, {
    tags: { route: ROUTE, service: SERVICE, alert_path: 'instant', desk: story.desk },
    extra: { requestId, durationMs, articleId: story.id },
  });

  return createSessionAndAlert({
    issueTitle: "TypeError: Barron's stories fail to publish (DeskRegistry::forSite returned null)",
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'src/Editorial/DeskRegistry.php — DowJones\\Newsroom\\Editorial\\DeskRegistry::forSite',
    errorType: 'TypeError',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'Newsroom desk publishing',
    promptAppendix: buildDirective({ story, requestId }),
    customer: 'a1c50ac4',
    skipVulnerablePr: true,
    slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    tags: [
      { key: 'route', value: 'POST /wp-json/dj/v1/articles/{id}/publish' },
      { key: 'service', value: 'newsroom-wp' },
      { key: 'site', value: DESKS[story.desk].path },
      { key: 'runtime', value: 'php-fpm 8.3' },
    ],
    extra: { requestId, durationMs, articleId: story.id, repo: TARGET_REPO },
    level: 'error',
    platform: 'php',
    firstSeen: '',
    lastSeen: new Date().toISOString(),
    count: '',
    shortId: '',
    project: 'newsroom-wp',
    release: 'newsroom-wp@2026.11.06',
    environment: 'prod',
    triggeredRule: 'Publish errors on any desk > 0 for 1 min',
  }).catch((alertError) => {
    logger.error('Failed to create Devin session for publish failure', { error: alertError.message, requestId });
  });
}

function publishStory(data = {}) {
  const startTime = Date.now();
  const requestData = data && typeof data === 'object' ? data : {};
  const requestId = `PUB-${uuidv4().slice(0, 8).toUpperCase()}`;
  const story = QUEUE.find((s) => s.id === Number(requestData.articleId));
  if (!story) {
    const error = new Error('Article not found.');
    error.name = 'ValidationError';
    error.code = 'ARTICLE_NOT_FOUND';
    error.statusCode = 404;
    throw error;
  }

  try {
    const desk = deskForSite(DESKS[story.desk].path);
    const durationMs = Date.now() - startTime;
    incrementMetric('newsroom.publish_success', { route: ROUTE, desk: story.desk });
    recordTiming('newsroom.publish.latency', durationMs, { route: ROUTE, outcome: 'success' });
    return {
      success: true,
      requestId,
      id: story.id,
      status: 'publish',
      desk: desk.brand,
      paywall: desk.paywall,
      link: `https://newsroom.dowjones.example${DESKS[story.desk].path}2026/11/${story.slug}/`,
      durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    incrementMetric('newsroom.publish_failed', { route: ROUTE, desk: story.desk, reason: 'type_error' });
    recordTiming('newsroom.publish.latency', durationMs, { route: ROUTE, outcome: 'error' });
    logger.error('Desk publish failed — Posting alert and triggering Devin', {
      requestId, articleId: story.id, desk: story.desk, error: error.message, service: SERVICE,
    });
    setImmediate(() => reportPublishFailure({ requestId, durationMs, story, error, data: requestData }));

    const failure = new Error(error.message);
    failure.name = error.name;
    failure.code = 'PUBLISH_FAILED';
    failure.statusCode = 500;
    failure.requestId = requestId;
    throw failure;
  }
}

module.exports = {
  publishStory,
  listQueue,
  buildDirective,
  deskForSite,
  DESK_REGISTRY,
  QUEUE,
};
