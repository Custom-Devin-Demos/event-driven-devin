/**
 * Riot Games — Account Management (Riot ID update).
 *
 * Node port of the Foundations SDK `AuthClient::UpdateRiotId` path used by the
 * account.riotgames.com "Riot ID" tab: the session token is resolved to a
 * player, the tagline is validated against the rules for the shard the player
 * is homed on, and the Riot ID is rewritten on the session.
 *
 * Intentional demo defect: `TAGLINE_RULES` was populated during the 2025
 * shard-rules migration for the shards that had already cut over. NA1 (and
 * LA1/LA2) were scheduled for the second wave and never got a row, but Riot ID
 * editing was enabled for every shard at once. `findTaglineRules()` therefore
 * returns `undefined` for NA1 players and `validateTagline()` crashes reading
 * `.maxLength` off it.
 */
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'customer-6f38d771-riot-account-foundations';
const ROUTE = '/api/6f38d771/riot-id';
const SLACK_MEMBER_ID = process.env.RIOT_SLACK_MEMBER_ID || 'U08S7AVJ478';

/**
 * Synthetic account fixtures mirroring the Foundations SDK data store.
 */
const ACCOUNTS = {
  'garen.demacia': {
    puuid: 'puuid-0001-garen',
    gameName: 'GarenMain',
    tagLine: 'NA1',
    region: 'NA1',
    locale: 'en-US',
    accountLevel: 212,
    statusMessage: 'DEMACIA!',
    games: [
      { game: 'lol', level: 212, ranked: [{ queue: 'RANKED_SOLO_5x5', tier: 'PLATINUM', division: 'II', leaguePoints: 43, wins: 210, losses: 198 }] },
      { game: 'tft', level: 88, ranked: [{ queue: 'RANKED_TFT', tier: 'GOLD', division: 'I', leaguePoints: 12, wins: 55, losses: 61 }] },
    ],
  },
  'jinx.powder': {
    puuid: 'puuid-0002-jinx',
    gameName: 'PowderKeg',
    tagLine: 'EUW',
    region: 'EUW1',
    locale: 'en-GB',
    accountLevel: 340,
    statusMessage: 'Rules are made to be broken',
    games: [
      { game: 'lol', level: 340, ranked: [{ queue: 'RANKED_SOLO_5x5', tier: 'DIAMOND', division: 'IV', leaguePoints: 75, wins: 412, losses: 388 }] },
      { game: 'valorant', level: 120, ranked: [{ queue: 'competitive', tier: 'Ascendant', division: '2', leaguePoints: 0, wins: 98, losses: 84 }] },
    ],
  },
  'faker.hide': {
    puuid: 'puuid-0003-faker',
    gameName: 'Hide on bush',
    tagLine: 'KR1',
    region: 'KR',
    locale: 'ko-KR',
    accountLevel: 999,
    statusMessage: '',
    games: [
      { game: 'lol', level: 999, ranked: [{ queue: 'RANKED_SOLO_5x5', tier: 'CHALLENGER', division: 'I', leaguePoints: 1428, wins: 890, losses: 612 }] },
    ],
  },
  'penguin.pengu': {
    puuid: 'puuid-0004-pengu',
    gameName: 'FeatherKnight',
    tagLine: 'OCE',
    region: 'OC1',
    locale: 'en-AU',
    accountLevel: 64,
    statusMessage: 'TFT enjoyer',
    games: [
      { game: 'tft', level: 64, ranked: [{ queue: 'RANKED_TFT', tier: 'MASTER', division: 'I', leaguePoints: 220, wins: 301, losses: 264 }] },
    ],
  },
  'arcane.vi': {
    puuid: 'puuid-0005-vi',
    gameName: 'PiltoverFist',
    tagLine: 'NA1',
    region: 'NA1',
    locale: 'en-US',
    accountLevel: 158,
    statusMessage: 'Punch first, ask questions while punching',
    games: [
      { game: 'lol', level: 158, ranked: [{ queue: 'RANKED_SOLO_5x5', tier: 'EMERALD', division: 'III', leaguePoints: 18, wins: 154, losses: 149 }] },
    ],
  },
};

/**
 * Shards that have Riot ID editing enabled. Every shard listed here is
 * expected to carry a matching TAGLINE_RULES row.
 */
const SHARDS = {
  NA1: { code: 'NA1', label: 'North America', platform: 'na1.api.riotgames.com', cluster: 'americas' },
  BR1: { code: 'BR1', label: 'Brazil', platform: 'br1.api.riotgames.com', cluster: 'americas' },
  LA1: { code: 'LA1', label: 'Latin America North', platform: 'la1.api.riotgames.com', cluster: 'americas' },
  LA2: { code: 'LA2', label: 'Latin America South', platform: 'la2.api.riotgames.com', cluster: 'americas' },
  EUW1: { code: 'EUW1', label: 'Europe West', platform: 'euw1.api.riotgames.com', cluster: 'europe' },
  EUN1: { code: 'EUN1', label: 'Europe Nordic & East', platform: 'eun1.api.riotgames.com', cluster: 'europe' },
  TR1: { code: 'TR1', label: 'Türkiye', platform: 'tr1.api.riotgames.com', cluster: 'europe' },
  KR: { code: 'KR', label: 'Korea', platform: 'kr.api.riotgames.com', cluster: 'asia' },
  JP1: { code: 'JP1', label: 'Japan', platform: 'jp1.api.riotgames.com', cluster: 'asia' },
  OC1: { code: 'OC1', label: 'Oceania', platform: 'oc1.api.riotgames.com', cluster: 'sea' },
};

/**
 * Per-shard tagline rules keyed by the shard the player's profile is homed
 * on. Populated during the 2025 shard-rules migration (wave 1 shards only);
 * wave 2 shards must be registered here before Riot ID edits go live for them.
 * BUG: NA1 / LA1 / LA2 are enabled in SHARDS but have no row here.
 */
const TAGLINE_RULES = {
  EUW1: { minLength: 2, maxLength: 5, charset: /^[A-Za-z0-9]+$/, changeCooldownDays: 30 },
  EUN1: { minLength: 2, maxLength: 5, charset: /^[A-Za-z0-9]+$/, changeCooldownDays: 30 },
  TR1: { minLength: 2, maxLength: 5, charset: /^[A-Za-z0-9]+$/, changeCooldownDays: 30 },
  KR: { minLength: 2, maxLength: 5, charset: /^[A-Za-z0-9가-힣]+$/, changeCooldownDays: 30 },
  JP1: { minLength: 2, maxLength: 5, charset: /^[A-Za-z0-9]+$/, changeCooldownDays: 30 },
  OC1: { minLength: 2, maxLength: 5, charset: /^[A-Za-z0-9]+$/, changeCooldownDays: 30 },
  BR1: { minLength: 2, maxLength: 5, charset: /^[A-Za-z0-9]+$/, changeCooldownDays: 30 },
};

const POLICY_REJECTION_CODES = new Set(['TAGLINE_LENGTH', 'TAGLINE_CHARSET', 'GAME_NAME_LENGTH']);
const GAME_NAME_MIN = 3;
const GAME_NAME_MAX = 16;

function resolveAccount(username) {
  const account = ACCOUNTS[username];
  if (!account) {
    throw Object.assign(new Error(`INVALID_CREDENTIALS: unknown account ${username}`), { code: 'INVALID_CREDENTIALS' });
  }
  return account;
}

function issueSessionToken(username) {
  const seed = `${username}|${Date.now()}|${Math.random()}`;
  return `rfs-${crypto.createHash('sha256').update(seed).digest('hex')}`;
}

/**
 * Looks up the tagline rules registered for the shard a profile is homed on.
 */
function findTaglineRules(shard) {
  return TAGLINE_RULES[shard];
}

/**
 * Validates the requested tagline against the player's shard rules.
 * BUG: TAGLINE_RULES has no NA1 row, so `rules.maxLength` throws a TypeError
 * for the default GarenMain#NA1 account.
 */
function validateTagline(tagLine, shard) {
  const rules = findTaglineRules(shard);
  const maxLength = rules.maxLength;
  if (tagLine.length < rules.minLength || tagLine.length > maxLength) {
    throw Object.assign(
      new Error(`tagline must be between ${rules.minLength} and ${maxLength} characters for shard ${shard}`),
      { code: 'TAGLINE_LENGTH' },
    );
  }
  if (!rules.charset.test(tagLine)) {
    throw Object.assign(new Error(`tagline contains characters not allowed on shard ${shard}`), { code: 'TAGLINE_CHARSET' });
  }
  return {
    shard,
    minLength: rules.minLength,
    maxLength,
    nextChangeAllowedAt: new Date(Date.now() + rules.changeCooldownDays * 86400000).toISOString(),
  };
}

function validateGameName(gameName) {
  if (gameName.length < GAME_NAME_MIN || gameName.length > GAME_NAME_MAX) {
    throw Object.assign(
      new Error(`game name must be between ${GAME_NAME_MIN} and ${GAME_NAME_MAX} characters`),
      { code: 'GAME_NAME_LENGTH' },
    );
  }
}

/**
 * Updates the Riot ID (game name + tagline) for a signed-in account.
 */
async function updateRiotId(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Updating Riot ID', {
    requestId,
    username: data.username,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const account = resolveAccount(data.username);
    const shard = SHARDS[account.region];
    validateGameName(data.gameName);
    const taglinePolicy = validateTagline(data.tagLine, account.region);

    const token = issueSessionToken(data.username);
    const duration = Date.now() - startTime;

    incrementMetric('riot_id.update.success', { route: ROUTE, shard: account.region, cluster: shard.cluster });
    recordTiming('riot_id.update.latency', duration, { route: ROUTE });

    return {
      success: true,
      requestId,
      status: 'OK',
      session: {
        token,
        puuid: account.puuid,
        gameName: data.gameName,
        tagLine: data.tagLine,
        previousRiotId: `${account.gameName}#${account.tagLine}`,
        riotId: `${data.gameName}#${data.tagLine}`,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
      shard,
      taglinePolicy,
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    if (POLICY_REJECTION_CODES.has(error.code)) {
      incrementMetric('riot_id.update.rejected', { route: ROUTE, code: error.code });
      logger.warn('Riot ID update rejected by shard policy', { requestId, code: error.code, username: data.username, service: SERVICE });
      throw error;
    }

    incrementMetric('riot_id.update.failure', { route: ROUTE, errorClass: error.name, username: data.username });
    recordTiming('riot_id.update.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Riot ID update failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      username: data.username,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, source: 'riot-account-riot-id', alert_path: 'instant' },
      extra: { requestId, username: data.username },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/6f38d771.js \u2014 validateTagline',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: '6f38d771',
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      service: SERVICE,
      verticalLabel: 'Riot Games \u2014 Account Management (Riot ID)',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'sdk', value: 'foundations-web' },
      ],
      extra: { requestId, username: data.username },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@1.0.0`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Riot ID update error', { error: err.message });
    });

    throw error;
  }
}

module.exports = {
  updateRiotId,
  resolveAccount,
  findTaglineRules,
  validateTagline,
  validateGameName,
  ACCOUNTS,
  SHARDS,
  TAGLINE_RULES,
  POLICY_REJECTION_CODES,
  GAME_NAME_MIN,
  GAME_NAME_MAX,
};
