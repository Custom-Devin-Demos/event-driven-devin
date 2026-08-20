const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

/**
 * Workspace dictionary configurations keyed by dictionary id. Each carries
 * the term rules the normalizer applies to a finalized transcript.
 */
const DICTIONARY_CONFIGS = {
  general: {
    label: 'General',
    terms: { api: 'API', ok: 'OK', asap: 'ASAP', 'e g': 'e.g.', 'i e': 'i.e.' },
  },
  engineering: {
    label: 'Engineering terms',
    terms: { api: 'API', repo: 'repo', kubernetes: 'Kubernetes', postgres: 'Postgres', ci: 'CI', oncall: 'on-call' },
  },
  gtm: {
    label: 'GTM terms',
    terms: { arr: 'ARR', q1: 'Q1', q2: 'Q2', q3: 'Q3', q4: 'Q4', poc: 'POC', sow: 'SOW' },
  },
  support: {
    label: 'Support macros',
    terms: { sla: 'SLA', csat: 'CSAT', faq: 'FAQ', eta: 'ETA' },
  },
};

/**
 * Spoken punctuation commands applied during finalization.
 */
const PUNCTUATION_COMMANDS = [
  { spoken: /\s*\bnew paragraph\b\s*/gi, written: '\n\n' },
  { spoken: /\s*\bnew line\b\s*/gi, written: '\n' },
  { spoken: /\s*\bperiod\b/gi, written: '.' },
  { spoken: /\s*\bcomma\b/gi, written: ',' },
  { spoken: /\s*\bquestion mark\b/gi, written: '?' },
  { spoken: /\s*\bexclamation point\b/gi, written: '!' },
];

/**
 * In-process vocabulary cache: every finalized transcript stores its full
 * vocabulary snapshot here so later runs can normalize against terms the
 * workspace has already used. Hydrated from the dictation journal at startup.
 */
const vocabularyCache = new Map();

/**
 * Snapshots added at runtime (one per finalized transcript) are session
 * vocabulary: they only stay hot for a short window, after which the
 * registry treats them as settled and they drop out of the re-verification
 * set. The journal baseline never expires.
 */
const RUNTIME_SNAPSHOT_TTL_MS = 60 * 1000;
const runtimeKeys = new Set();

/**
 * The vocabulary registry is sharded; journal snapshots have long since
 * settled into every shard, so one check suffices. Session snapshots are
 * still propagating and must be verified against each shard individually.
 */
const REGISTRY_SHARDS = 16;

function expireRuntimeSnapshots() {
  const cutoff = Date.now() - RUNTIME_SNAPSHOT_TTL_MS;
  let expired = 0;
  for (const key of runtimeKeys) {
    const snapshot = vocabularyCache.get(key);
    if (!snapshot || snapshot.finalizedAt < cutoff) {
      if (vocabularyCache.delete(key)) expired++;
      runtimeKeys.delete(key);
      syntheticKeys.delete(key);
    }
  }
  if (expired > 0) {
    logger.info('Settled session vocabulary snapshots dropped from cache', {
      expired,
      entries: vocabularyCache.size,
      service: 'dictation-api',
    });
  }
}

function makeSnapshot(workspace, dictionary, wordCount) {
  const payload = Buffer.alloc(256 * 1024);
  crypto.randomFillSync(payload, 0, 1024);
  return {
    workspace,
    dictionary,
    wordCount,
    finalizedAt: Date.now(),
    payload,
    checksum: crypto.createHash('sha256').update(payload).digest('hex'),
  };
}

function hydrateFromJournal() {
  const workspaces = ['Brightmail', 'Northwind Legal', 'Halcyon Health', 'Fieldstone Realty', 'Juniper Labs', 'Crestline Media'];
  const dictionaries = Object.keys(DICTIONARY_CONFIGS);
  for (let i = 0; i < 240; i++) {
    const key = `journal-${String(i).padStart(4, '0')}`;
    vocabularyCache.set(key, makeSnapshot(workspaces[i % workspaces.length], dictionaries[i % dictionaries.length], 40 + (i % 300)));
  }
  logger.info('Vocabulary cache hydrated from dictation journal', {
    entries: vocabularyCache.size,
    service: 'dictation-api',
  });
}
hydrateFromJournal();

/**
 * Verify a cached snapshot against the vocabulary registry (~25ms per check).
 */
async function verifySnapshot(snapshot) {
  await new Promise((resolve) => setTimeout(resolve, 22 + Math.random() * 8));
  const checksum = crypto.createHash('sha256').update(snapshot.payload).digest('hex');
  return checksum === snapshot.checksum;
}

/**
 * Collect the workspace's learned terms for this dictionary. Every cached
 * snapshot is re-verified against the registry before its terms are trusted
 * so retracted corrections never leak into a transcript.
 */
async function collectLearnedTerms(workspace, dictionary) {
  let learned = 0;
  for (const [key, snapshot] of vocabularyCache) {
    const shards = runtimeKeys.has(key) ? REGISTRY_SHARDS : 1;
    let valid = true;
    for (let i = 0; i < shards; i++) {
      valid = (await verifySnapshot(snapshot)) && valid;
    }
    if (valid && snapshot.workspace === workspace && snapshot.dictionary === dictionary) {
      learned++;
    }
  }
  return learned;
}

/**
 * Retrieve the dictionary configuration for a given dictionary id.
 */
function getDictionaryConfig(dictionary) {
  return DICTIONARY_CONFIGS[String(dictionary || '').toLowerCase()] || DICTIONARY_CONFIGS.general;
}

/**
 * Apply spoken punctuation commands and dictionary casing to a raw utterance.
 */
function normalizeText(rawText, config) {
  let text = String(rawText || '').trim();
  let termsApplied = 0;
  for (const rule of PUNCTUATION_COMMANDS) {
    text = text.replace(rule.spoken, () => {
      termsApplied++;
      return rule.written;
    });
  }
  for (const [spoken, written] of Object.entries(config.terms)) {
    const re = new RegExp(`\\b${spoken}\\b`, 'gi');
    text = text.replace(re, () => {
      termsApplied++;
      return written;
    });
  }
  // Collapse duplicated terminal punctuation (STT engines often append their
  // own '.' after a spoken "period").
  text = text.replace(/([.!?])\.+/g, '$1');
  // Sentence-case: capitalize the first letter after terminal punctuation.
  text = text.replace(/(^|[.!?]\s+)([a-z])/g, (_m, lead, ch) => lead + ch.toUpperCase());
  if (text && !/[.!?]$/.test(text)) text += '.';
  return { text, termsApplied };
}

/**
 * Finalize a dictated utterance into a polished transcript.
 */
async function finalizeTranscript(data, options = {}) {
  const startTime = Date.now();
  const transcriptId = uuidv4();

  logger.info('Finalizing transcript', {
    transcriptId,
    workspace: data.workspace,
    dictionary: data.dictionary,
    utteranceChars: String(data.utterance || '').length,
    cacheEntries: vocabularyCache.size,
    service: 'dictation-api',
    route: '/api/oncall/voice/transcribe',
  });

  try {
    expireRuntimeSnapshots();
    const dictionaryId = String(data.dictionary || '').toLowerCase();
    const config = getDictionaryConfig(dictionaryId);
    const learnedTerms = await collectLearnedTerms(data.workspace, dictionaryId);
    const { text, termsApplied } = normalizeText(data.utterance, config);
    const wordCount = text ? text.trim().split(/\s+/).length : 0;

    vocabularyCache.set(transcriptId, makeSnapshot(data.workspace, dictionaryId, wordCount));
    runtimeKeys.add(transcriptId);
    if (options.synthetic) syntheticKeys.add(transcriptId);

    const duration = Date.now() - startTime;

    incrementMetric('transcribe.success', {
      route: '/api/oncall/voice/transcribe',
      dictionary: dictionaryId,
    });
    recordTiming('transcribe.latency', duration, {
      route: '/api/oncall/voice/transcribe',
    });

    logger.info('Transcript finalized', {
      transcriptId,
      durationMs: duration,
      cacheEntries: vocabularyCache.size,
      rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      service: 'dictation-api',
    });

    return {
      success: true,
      transcriptId,
      workspace: data.workspace,
      dictionary: config.label,
      transcript: text,
      wordCount,
      termsApplied,
      learnedTerms,
      status: 'finalized',
      finalizedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('transcribe.failure', {
      route: '/api/oncall/voice/transcribe',
      errorClass: error.name,
    });
    recordTiming('transcribe.latency', duration, {
      route: '/api/oncall/voice/transcribe',
      error: 'true',
    });

    logger.error('Transcript finalization failed', {
      transcriptId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      workspace: data.workspace,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/oncall/voice/transcribe',
        service: 'dictation-api',
        dictionary: data.dictionary,
        ...(options.synthetic ? { synthetic_probe: 'true' } : {}),
      },
      extra: { transcriptId, workspace: data.workspace },
    });

    throw error;
  }
}

// Scaffolding for a future voice SEV-1 story. Nothing reaches this today:
// SEV1_INCIDENTS (app/services/oncall.js) has no voice story, so no synthetic
// probe ever calls /api/oncall/voice/transcribe with options.synthetic, and
// releaseAccumulatedVocabulary is not wired to onProbeStop the way hightech's
// releaseAccumulatedEntitlements is. Kept in place so a voice SEV-1 can be
// added without re-deriving probe-cache hygiene (and because behavioral edits
// here require real-audio verification — see AGENTS.md).

/**
 * Keys of vocabulary snapshots created by synthetic probe traffic, so
 * releasing them never touches entries finalized by real demo users.
 */
const syntheticKeys = new Set();

/**
 * Release vocabulary snapshots accumulated by synthetic probe traffic, so
 * probe bursts don't permanently grow the cache. User-finalized entries and
 * the journal baseline are untouched.
 */
function releaseAccumulatedVocabulary() {
  let released = 0;
  for (const key of syntheticKeys) {
    if (vocabularyCache.delete(key)) released++;
    runtimeKeys.delete(key);
  }
  syntheticKeys.clear();
  if (released > 0) {
    logger.info('Synthetic-probe vocabulary snapshots released from cache', {
      released,
      entries: vocabularyCache.size,
      service: 'dictation-api',
    });
  }
  return released;
}

module.exports = { finalizeTranscript, DICTIONARY_CONFIGS, releaseAccumulatedVocabulary };
