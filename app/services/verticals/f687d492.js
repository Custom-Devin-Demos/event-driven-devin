const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const {
  INDEX_FAMILY,
  rosterFor,
  lineWeight,
  divisorFor,
  collectClosingPrices,
  round,
} = require('./f687d492-constituents');
const {
  DISTRIBUTION_CHANNELS,
  buildDistributionManifest,
  releaseToChannels,
} = require('./f687d492-dissemination');

const SERVICE = 'f687d492-api';
const ROUTE = '/api/f687d492/publish';
const ENGINE_VERSION = '9.4.2';
const TOLERANCE_PCT = 7;
const MARKET_CLOSE = '16:00 ET';
const FIRST_DEADLINE = '16:20 ET';

const STAGES = [
  { id: 'collect', name: 'Collect closing prints', detail: 'Official 4:00 pm closing prices from the consolidated tape' },
  { id: 'calculate', name: 'Calculate official levels', detail: 'Apply index divisors and float adjustments' },
  { id: 'validate', name: 'Validate vs. prior close', detail: 'Tolerance band and constituent coverage checks' },
  { id: 'manifest', name: 'Build distribution manifest', detail: 'Settlement values, vendor records, EOD files, web payloads' },
  { id: 'release', name: 'Release to channels', detail: 'Exchanges, vendor feeds, SFTP drops, public site' },
];

const PUBLICATIONS = [];
const publicationState = {
  status: 'standby',
  haltedAt: null,
  lastError: null,
  nextSeq: 1,
  generation: 0,
};

const HISTORY_LIMIT = 30;

function pad(value) {
  return String(value).padStart(2, '0');
}

function isoDate(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function easternCalendarDate(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now).reduce((acc, part) => Object.assign(acc, { [part.type]: part.value }), {});
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
}

function previousTradingDay(date) {
  const next = new Date(date.getTime());
  do {
    next.setUTCDate(next.getUTCDate() - 1);
  } while (next.getUTCDay() === 0 || next.getUTCDay() === 6);
  return next;
}

function currentTradeDate() {
  const eastern = easternCalendarDate(new Date());
  const day = eastern.getUTCDay();
  if (day === 0 || day === 6) {
    return isoDate(previousTradingDay(eastern));
  }
  return isoDate(eastern);
}

function recordPublication(run) {
  PUBLICATIONS.unshift(run);
  if (PUBLICATIONS.length > HISTORY_LIMIT) PUBLICATIONS.length = HISTORY_LIMIT;
}

function tradeDateLabel(tradeDate) {
  const [year, month, day] = tradeDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

function publicationIdFor(tradeDate, seq) {
  return `PUB-${tradeDate.replace(/-/g, '')}-${pad(seq)}`;
}

function seedPublications() {
  const seeds = [];
  const clocks = ['16:17:52', '16:18:09', '16:17:31', '16:19:04', '16:18:27'];
  const running = {};
  INDEX_FAMILY.forEach((index) => { running[index.id] = index.priorClose; });
  let cursor = new Date(`${currentTradeDate()}T00:00:00Z`);
  for (let i = 0; i < clocks.length; i += 1) {
    cursor = previousTradingDay(cursor);
    const tradeDate = isoDate(cursor);
    const levels = INDEX_FAMILY.map((index) => {
      const changePct = (((i * 7 + index.id.charCodeAt(0) * 3) % 13) - 6) / 10;
      const officialClose = round(running[index.id], 2);
      running[index.id] = officialClose / (1 + changePct / 100);
      return {
        indexId: index.id,
        ticker: index.ticker,
        name: index.name,
        officialClose,
        changePct,
      };
    });
    seeds.push({
      publicationId: publicationIdFor(tradeDate, 1),
      tradeDate,
      status: 'published',
      startedAt: `${tradeDate}T20:${clocks[i].slice(3)}Z`,
      publishedAtLabel: `${clocks[i]} ET`,
      durationMs: 4200 + i * 310,
      indicesPublished: levels.length,
      channelsDelivered: DISTRIBUTION_CHANNELS.length,
      recipients: DISTRIBUTION_CHANNELS.reduce((sum, channel) => sum + channel.recipients, 0),
      failedStage: null,
      error: null,
      levels,
    });
  }
  return seeds;
}

function seedState() {
  PUBLICATIONS.splice(0, PUBLICATIONS.length, ...seedPublications());
  publicationState.status = 'standby';
  publicationState.haltedAt = null;
  publicationState.lastError = null;
  publicationState.nextSeq = 1;
  publicationState.generation += 1;
}

seedState();

function computeOfficialLevel(index, priceSet) {
  const divisor = divisorFor(index);
  const aggregate = priceSet.priced.reduce(
    (sum, line) => sum + line.close * lineWeight(index, line),
    0,
  );
  return round(aggregate / divisor, 2);
}

function validateLevel(index, officialClose, priceSet) {
  const changePct = ((officialClose / index.priorClose) - 1) * 100;
  const universe = priceSet.priced.length + priceSet.missing.length;
  const coverage = universe ? priceSet.priced.length / universe : 0;
  if (Math.abs(changePct) > TOLERANCE_PCT) {
    throw new Error(`${index.ticker} official close ${officialClose} breaches ±${TOLERANCE_PCT}% tolerance band`);
  }
  if (priceSet.missing.length) {
    throw new Error(`${index.ticker} missing official closing prints for ${priceSet.missing.join(', ')}`);
  }
  return { changePct: round(changePct, 2), coverage: round(coverage, 4) };
}

function stageName(stageId) {
  const stage = STAGES.find((item) => item.id === stageId);
  return stage ? stage.name : stageId;
}

function runStage(run, stageId, work) {
  run.stage = stageId;
  const output = work();
  run.stagesCompleted.push(stageId);
  return output;
}

function summarizePublication(run) {
  return {
    publicationId: run.publicationId,
    tradeDate: run.tradeDate,
    tradeDateLabel: tradeDateLabel(run.tradeDate),
    status: run.status,
    startedAt: run.startedAt,
    publishedAtLabel: run.publishedAtLabel || null,
    durationMs: run.durationMs,
    indicesPublished: run.indicesPublished,
    channelsDelivered: run.channelsDelivered,
    recipients: run.recipients,
    failedStage: run.failedStage ? stageName(run.failedStage) : null,
    failedIndex: run.failedIndex || null,
    error: run.error,
    levels: run.levels,
  };
}

function formatPublication(run, manifest) {
  return {
    success: true,
    publicationId: run.publicationId,
    requestId: run.requestId,
    tradeDate: run.tradeDate,
    manifestId: manifest.manifestId,
    levels: run.levels,
    deliveries: manifest.deliveries,
    durationMs: run.durationMs,
    status: publicationState.status,
  };
}

function clockLabel(date) {
  return `${date.toLocaleTimeString('en-US', { hour12: false, timeZone: 'America/New_York' })} ET`;
}

function getOverview() {
  const tradeDate = currentTradeDate();
  const published = PUBLICATIONS.filter((run) => run.status === 'published');
  const failed = PUBLICATIONS.filter((run) => run.status === 'failed');
  const todayRun = published.find((run) => run.tradeDate === tradeDate) || null;
  const recipients = DISTRIBUTION_CHANNELS.reduce((sum, channel) => sum + channel.recipients, 0);
  return {
    service: SERVICE,
    engineVersion: ENGINE_VERSION,
    region: 'us-east-1 · DR us-west-2',
    tradeDate,
    tradeDateLabel: tradeDateLabel(tradeDate),
    marketClose: MARKET_CLOSE,
    firstDeadline: FIRST_DEADLINE,
    status: publicationState.status,
    haltedAt: publicationState.haltedAt,
    lastError: publicationState.lastError,
    scheduler: 'Manual release · index operations desk approves each publication',
    nextPublicationId: publicationIdFor(tradeDate, publicationState.nextSeq),
    summary: {
      indicesInScope: INDEX_FAMILY.length,
      constituentsInScope: INDEX_FAMILY.reduce((sum, index) => sum + index.constituents, 0),
      channels: DISTRIBUTION_CHANNELS.length,
      recipients,
      publishedOnTime: published.length,
      failedPublications: failed.length,
      lastPublishedAt: published.length ? published[0].startedAt : null,
      toleranceBandPct: TOLERANCE_PCT,
    },
    stages: STAGES,
    indices: INDEX_FAMILY.map((index) => {
      const todayLevel = todayRun
        ? todayRun.levels.find((level) => level.indexId === index.id)
        : null;
      return {
        ...index,
        sampleSize: rosterFor(index).length,
        divisor: round(divisorFor(index), 4),
        officialClose: todayLevel ? todayLevel.officialClose : null,
        changePct: todayLevel ? todayLevel.changePct : null,
      };
    }),
    channels: DISTRIBUTION_CHANNELS,
    publications: PUBLICATIONS.map(summarizePublication),
  };
}

function listConstituents() {
  return INDEX_FAMILY.map((index) => ({
    indexId: index.id,
    ticker: index.ticker,
    name: index.name,
    weighting: index.weighting,
    constituents: index.constituents,
    sample: rosterFor(index),
  }));
}

async function publishOfficialClose(data = {}) {
  const requestId = uuidv4();
  const startedAt = new Date();
  const tradeDate = currentTradeDate();
  const generation = publicationState.generation;
  const run = {
    publicationId: publicationIdFor(tradeDate, publicationState.nextSeq),
    requestId,
    tradeDate,
    status: 'running',
    startedAt: startedAt.toISOString(),
    stage: null,
    stagesCompleted: [],
    levels: [],
    indicesPublished: 0,
    channelsDelivered: 0,
    recipients: 0,
    failedStage: null,
    failedIndex: null,
    error: null,
    durationMs: 0,
  };
  publicationState.nextSeq += 1;

  logger.info('Official close publication started', {
    requestId,
    publicationId: run.publicationId,
    tradeDate,
    indices: INDEX_FAMILY.map((index) => index.ticker),
    trigger: data.trigger || 'manual',
    service: SERVICE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 110));

    if (generation !== publicationState.generation) {
      run.status = 'discarded';
      run.durationMs = Date.now() - startedAt.getTime();
      logger.warn('Official close publication discarded — console was reset mid-run', {
        requestId,
        publicationId: run.publicationId,
        service: SERVICE,
      });
      incrementMetric('index_close.publication.discarded', { route: ROUTE });
      return { success: false, discarded: true, publicationId: run.publicationId, requestId, status: publicationState.status };
    }

    const priceSets = runStage(run, 'collect', () => INDEX_FAMILY.map(
      (index) => collectClosingPrices(index, tradeDate),
    ));

    const levels = runStage(run, 'calculate', () => INDEX_FAMILY.map((index, position) => {
      run.failedIndex = index.ticker;
      const priceSet = priceSets[position];
      const officialClose = computeOfficialLevel(index, priceSet);
      return {
        indexId: index.id,
        ticker: index.ticker,
        name: index.name,
        priorClose: index.priorClose,
        officialClose,
        priceSet,
      };
    }));

    runStage(run, 'validate', () => levels.forEach((level, position) => {
      run.failedIndex = level.ticker;
      Object.assign(level, validateLevel(INDEX_FAMILY[position], level.officialClose, level.priceSet));
      delete level.priceSet;
    }));
    run.failedIndex = null;

    const manifest = runStage(run, 'manifest', () => buildDistributionManifest(levels, priceSets, tradeDate));
    manifest.deliveries = runStage(run, 'release', () => releaseToChannels(manifest));

    const finishedAt = new Date();
    run.status = 'published';
    run.stage = null;
    run.levels = levels;
    run.indicesPublished = levels.length;
    run.channelsDelivered = manifest.deliveries.length;
    run.recipients = manifest.deliveries.reduce((sum, delivery) => sum + delivery.recipients, 0);
    run.durationMs = finishedAt.getTime() - startedAt.getTime();
    run.publishedAtLabel = clockLabel(finishedAt);
    recordPublication(run);
    publicationState.status = 'published';
    publicationState.haltedAt = null;
    publicationState.lastError = null;

    incrementMetric('index_close.publication.success', { route: ROUTE, indices: String(levels.length) });
    recordTiming('index_close.publication.latency', run.durationMs, { route: ROUTE });
    logger.info('Official close published', {
      requestId,
      publicationId: run.publicationId,
      manifestId: manifest.manifestId,
      indices: levels.length,
      recipients: run.recipients,
      durationMs: run.durationMs,
      service: SERVICE,
    });

    return formatPublication(run, manifest);
  } catch (error) {
    const failedAt = new Date();
    run.status = 'failed';
    run.failedStage = run.stage;
    run.durationMs = failedAt.getTime() - startedAt.getTime();
    run.error = { type: error.name, message: error.message };
    recordPublication(run);

    publicationState.status = 'halted';
    publicationState.haltedAt = failedAt.toISOString();
    publicationState.lastError = {
      type: error.name,
      message: error.message,
      stage: stageName(run.stage),
      index: run.failedIndex,
      publicationId: run.publicationId,
      requestId,
    };

    logger.error('Official close publication halted', {
      requestId,
      publicationId: run.publicationId,
      tradeDate,
      stage: run.stage,
      index: run.failedIndex,
      stagesCompleted: run.stagesCompleted,
      error: error.message,
      errorType: error.name,
      stack: error.stack,
      service: SERVICE,
    });
    incrementMetric('index_close.publication.failure', {
      route: ROUTE,
      stage: run.stage || 'unknown',
      error_type: error.name || 'Error',
    });
    recordTiming('index_close.publication.latency', run.durationMs, { route: ROUTE, outcome: 'failure' });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        stage: run.stage || 'unknown',
        index: run.failedIndex || 'n/a',
        alert_path: 'instant',
      },
      extra: {
        requestId,
        publicationId: run.publicationId,
        tradeDate,
        stagesCompleted: run.stagesCompleted,
        engineVersion: ENGINE_VERSION,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?query=${encodeURIComponent(requestId)}`,
      culprit: 'app/services/verticals/f687d492.js — publishOfficialClose',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'S&P Dow Jones Indices — Official Close Publication',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'stage', value: run.stage || 'unknown' },
        { key: 'index', value: run.failedIndex || 'n/a' },
      ],
      extra: {
        requestId,
        publicationId: run.publicationId,
        tradeDate,
        stage: run.stage,
        stagesCompleted: run.stagesCompleted,
        failedIndex: run.failedIndex,
        engineVersion: ENGINE_VERSION,
        firstDeadline: FIRST_DEADLINE,
        recipientsAwaiting: DISTRIBUTION_CHANNELS.reduce((sum, channel) => sum + channel.recipients, 0),
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: failedAt.toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'f687d492@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session', { error: err.message, requestId, service: SERVICE });
    });

    throw error;
  }
}

function resetPublication() {
  const cleared = PUBLICATIONS.filter((run) => run.status === 'failed').length;
  seedState();
  logger.info('Demo state reset', { cleared, service: SERVICE });
  incrementMetric('index_close.reset', { route: `${ROUTE}/reset` });
  return { success: true, cleared, status: publicationState.status, overview: getOverview() };
}

module.exports = {
  publishOfficialClose,
  resetPublication,
  getOverview,
  listConstituents,
  INDEX_FAMILY,
  DISTRIBUTION_CHANNELS,
  STAGES,
};
