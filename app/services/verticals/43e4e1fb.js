const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/43e4e1fb/editions/:id/download';
const SERVICE = 'economist-app-edition-packager';
const SLACK_MEMBER_ID = process.env.ECONOMIST_SLACK_MEMBER_ID || '';
const WORDS_PER_MINUTE = 230;

const READER = {
  name: 'Charlotte Hale',
  plan: 'Digital',
  region: 'GB',
  device: 'iPhone 16 Pro · The Economist 4.62',
};

/**
 * How each section is packaged for offline reading: which image rendition is
 * bundled, whether the narrated audio track is included, and the per-article
 * byte budget used to estimate the download size.
 */
const SECTION_PACKAGING = {
  'the-world-this-week': { imageRendition: 'none', audio: true, kbPerArticle: 120 },
  leaders: { imageRendition: 'w640', audio: true, kbPerArticle: 420 },
  letters: { imageRendition: 'none', audio: false, kbPerArticle: 40 },
  'by-invitation': { imageRendition: 'w640', audio: true, kbPerArticle: 380 },
  briefing: { imageRendition: 'w1280', audio: true, kbPerArticle: 900 },
  'united-states': { imageRendition: 'w640', audio: true, kbPerArticle: 400 },
  'the-americas': { imageRendition: 'w640', audio: true, kbPerArticle: 380 },
  asia: { imageRendition: 'w640', audio: true, kbPerArticle: 380 },
  china: { imageRendition: 'w640', audio: true, kbPerArticle: 380 },
  'middle-east-and-africa': { imageRendition: 'w640', audio: true, kbPerArticle: 380 },
  europe: { imageRendition: 'w640', audio: true, kbPerArticle: 380 },
  britain: { imageRendition: 'w640', audio: true, kbPerArticle: 380 },
  international: { imageRendition: 'w640', audio: true, kbPerArticle: 420 },
  business: { imageRendition: 'w640', audio: true, kbPerArticle: 400 },
  'finance-and-economics': { imageRendition: 'w640', audio: true, kbPerArticle: 400 },
  'science-and-technology': { imageRendition: 'w640', audio: true, kbPerArticle: 420 },
  culture: { imageRendition: 'w640', audio: true, kbPerArticle: 380 },
  'economic-and-financial-indicators': { imageRendition: 'w1280', audio: false, kbPerArticle: 260 },
  obituary: { imageRendition: 'w1280', audio: true, kbPerArticle: 520 },
};

const RENDITION_KB = { none: 0, w640: 180, w1280: 520 };

function a(flytitle, headline, rubric, words) {
  return { flytitle, headline, rubric, wordCount: words };
}

const SECTION_TITLES = {
  'the-world-this-week': 'The world this week',
  leaders: 'Leaders',
  letters: 'Letters',
  'by-invitation': 'By Invitation',
  briefing: 'Briefing',
  'united-states': 'United States',
  'the-americas': 'The Americas',
  asia: 'Asia',
  china: 'China',
  'middle-east-and-africa': 'Middle East & Africa',
  europe: 'Europe',
  britain: 'Britain',
  international: 'International',
  'technology-quarterly': 'Technology Quarterly',
  business: 'Business',
  'finance-and-economics': 'Finance & economics',
  'science-and-technology': 'Science & technology',
  culture: 'Culture',
  'economic-and-financial-indicators': 'Economic & financial indicators',
  obituary: 'Obituary',
};

const EDITIONS = {
  '2026-11-21': {
    id: '2026-11-21',
    date: 'Nov 21st 2026',
    coverLine: 'The machine-made economy',
    coverSub: 'AI agents are starting to do real work. Are firms ready?',
    coverTheme: 'agents',
    sections: {
      'the-world-this-week': [a('Politics', 'Politics this week', '', 1450), a('Business', 'Business this week', '', 1120), a('KAL\u2019s cartoon', 'KAL\u2019s cartoon', '', 60)],
      leaders: [a('Artificial intelligence', 'The machine-made economy', 'AI agents are starting to do real work. Firms and governments are not ready', 1210), a('Britain\u2019s budget', 'A budget for growth, at last?', 'The chancellor has a narrow window to fix the public finances', 980), a('China and Taiwan', 'Deterrence in the strait', 'America should be clear about what it would do', 930)],
      letters: [a('Letters', 'On tariffs, pensions, nuclear power and moustaches', '', 1100)],
      'by-invitation': [a('By Invitation', 'A central banker on why AI will not end inflation', 'Productivity booms are rarely disinflationary at first, argues a former governor', 920)],
      briefing: [a('Agentic AI', 'The new colleagues', 'Software that acts on its own is moving from demos to payrolls', 3600)],
      'united-states': [a('Lexington', 'The midterm hangover', '', 1010), a('Housing', 'Why American starter homes vanished', 'Zoning, rates and builders\u2019 margins all play a part', 890)],
      europe: [a('Charlemagne', 'Europe\u2019s defence awakening is real, if slow', '', 1000), a('Germany', 'The debt brake bends', '', 860)],
      britain: [a('Bagehot', 'The art of the U-turn', '', 1000), a('The NHS', 'Waiting lists finally fall', '', 840)],
      china: [a('Chaguan', 'What Chinese students think of America now', '', 1020), a('Property', 'The slow deflation of China\u2019s housing bubble', '', 900)],
      'technology-quarterly': [a('Technology Quarterly | AI at work', 'Agents of change', 'Autonomous software is beginning to reshape white-collar work', 2400), a('Technology Quarterly | AI at work', 'Who checks the checkers?', 'Testing AI agents is harder than building them', 2100), a('Technology Quarterly | AI at work', 'The productivity paradox, again', 'Where the gains are showing up\u2014and where they are not', 2200), a('Technology Quarterly | AI at work', 'The road ahead', 'Brief: what to watch in 2027', 1500)],
      business: [a('Schumpeter', 'The CEO as chief AI officer', '', 1000), a('Media', 'Can news publishers win the AI bargain?', 'Licensing deals are lucrative, but may be fleeting', 960)],
      'finance-and-economics': [a('Free exchange', 'The return of the productivity optimists', '', 1010), a('Bonds', 'Why term premiums are rising', '', 880)],
      'science-and-technology': [a('Fusion', 'A star in a jar, nearly', '', 1100), a('Medicine', 'GLP-1 drugs move beyond obesity', '', 940)],
      culture: [a('Back Story', 'The curious afterlife of the airport novel', '', 990), a('Books', 'The best books of 2026', '', 2400)],
      'economic-and-financial-indicators': [a('Indicators', 'Economic data, commodities and markets', '', 300)],
      obituary: [a('Obituary', 'A life spent mapping the ocean floor', '', 1050)],
    },
  },
  '2026-11-14': {
    id: '2026-11-14',
    date: 'Nov 14th 2026',
    coverLine: 'The world\u2019s new debt crisis',
    coverSub: 'Governments are borrowing as if rates will fall forever',
    coverTheme: 'debt',
    sections: {
      'the-world-this-week': [a('Politics', 'Politics this week', '', 1400), a('Business', 'Business this week', '', 1090), a('KAL\u2019s cartoon', 'KAL\u2019s cartoon', '', 60)],
      leaders: [a('Public finances', 'The world\u2019s new debt crisis', 'Governments are borrowing as if rates will fall forever', 1180), a('India', 'Modi\u2019s next reform', '', 950)],
      letters: [a('Letters', 'On carbon prices, Spanish trains and diplomacy', '', 1050)],
      briefing: [a('Sovereign debt', 'The bill comes due', '', 3400)],
      'united-states': [a('Lexington', 'Governing by executive order', '', 1000), a('Energy', 'America\u2019s grid is creaking', '', 900)],
      europe: [a('Charlemagne', 'France\u2019s fiscal reckoning', '', 1000)],
      britain: [a('Bagehot', 'Britain\u2019s quiet productivity puzzle', '', 990)],
      china: [a('Chaguan', 'Xi\u2019s new economic team', '', 1010)],
      business: [a('Schumpeter', 'Private equity\u2019s exit problem', '', 1000), a('Retail', 'The return of the department store?', '', 900)],
      'finance-and-economics': [a('Free exchange', 'Is r-star rising?', '', 1000), a('Banking', 'Private credit\u2019s first real test', '', 940)],
      'science-and-technology': [a('Climate', 'Solar geoengineering gets a hearing', '', 1050)],
      culture: [a('Back Story', 'Why opera houses are full again', '', 980)],
      'economic-and-financial-indicators': [a('Indicators', 'Economic data, commodities and markets', '', 300)],
      obituary: [a('Obituary', 'A diplomat who never raised his voice', '', 1040)],
    },
  },
  '2026-11-07': {
    id: '2026-11-07',
    date: 'Nov 7th 2026',
    coverLine: 'America votes, again',
    coverSub: 'What the midterms mean for the world',
    coverTheme: 'vote',
    sections: {
      'the-world-this-week': [a('Politics', 'Politics this week', '', 1420), a('Business', 'Business this week', '', 1100)],
      leaders: [a('The midterms', 'America votes, again', '', 1200), a('Oil', 'OPEC\u2019s fading grip', '', 930)],
      letters: [a('Letters', 'On housing, Brexit and the four-day week', '', 1020)],
      briefing: [a('The midterms', 'A house divided', '', 3500)],
      'united-states': [a('Lexington', 'The suburban swing', '', 1000)],
      business: [a('Schumpeter', 'The return of the conglomerate', '', 1000)],
      'finance-and-economics': [a('Free exchange', 'Tariffs and inflation, a year on', '', 1000)],
      culture: [a('Back Story', 'The long tail of streaming', '', 960)],
      'economic-and-financial-indicators': [a('Indicators', 'Economic data, commodities and markets', '', 300)],
      obituary: [a('Obituary', 'A chef who fed a city', '', 1030)],
    },
  },
};

const downloads = new Map();

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);
}

function readMinutes(words) {
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

function articleView(sectionId, art, editionId) {
  const audioSeconds = Math.round((art.wordCount / 155) * 60);
  return {
    id: `${editionId}-${sectionId}-${slugify(art.headline)}`,
    section: sectionId,
    sectionTitle: SECTION_TITLES[sectionId],
    flytitle: art.flytitle,
    headline: art.headline,
    rubric: art.rubric,
    wordCount: art.wordCount,
    readMinutes: readMinutes(art.wordCount),
    audioSeconds: sectionId === 'letters' || sectionId === 'economic-and-financial-indicators' ? 0 : audioSeconds,
  };
}

function getEdition(id, demoId) {
  const ed = EDITIONS[id];
  const sections = Object.keys(ed.sections).map((sid) => ({
    id: sid,
    title: SECTION_TITLES[sid],
    articles: ed.sections[sid].map((art) => articleView(sid, art, ed.id)),
  }));
  const articles = sections.reduce((n, s) => n + s.articles.length, 0);
  return {
    id: ed.id,
    date: ed.date,
    coverLine: ed.coverLine,
    coverSub: ed.coverSub,
    coverTheme: ed.coverTheme,
    articleCount: articles,
    sections,
    download: downloads.get(`${demoId || ''}:${ed.id}`) || null,
  };
}

function listEditions(demoId) {
  return {
    reader: READER,
    editions: Object.keys(EDITIONS).map((id) => {
      const ed = getEdition(id, demoId);
      return { id: ed.id, date: ed.date, coverLine: ed.coverLine, coverTheme: ed.coverTheme, articleCount: ed.articleCount, download: ed.download };
    }),
  };
}

/**
 * Builds the offline package for one section: image rendition and narrated
 * audio per article, with an estimated size.
 */
function packageSection(sectionId, articles) {
  const packaging = SECTION_PACKAGING[sectionId];
  const imageKb = RENDITION_KB[packaging.imageRendition];
  const items = articles.map((art) => ({
    articleId: art.id,
    image: packaging.imageRendition,
    audio: packaging.audio && art.audioSeconds > 0,
    kb: packaging.kbPerArticle + imageKb + (packaging.audio ? Math.round(art.audioSeconds * 8) : 0),
  }));
  return { section: sectionId, items, kb: items.reduce((n, i) => n + i.kb, 0) };
}

function resetDownloads(demoId) {
  for (const key of [...downloads.keys()]) {
    if (key.startsWith(`${demoId || ''}:`)) downloads.delete(key);
  }
}

async function downloadEdition(data) {
  const startTime = Date.now();
  const edition = getEdition(data.editionId, data.demoId);
  const requestId = data.requestId || uuidv4();
  const jobId = `DL-${uuidv4().slice(0, 8).toUpperCase()}`;

  logger.info('Packaging weekly edition for offline download', {
    jobId, requestId, editionId: edition.id, sections: edition.sections.length, articles: edition.articleCount, service: SERVICE, route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 900 + Math.random() * 500));

    const packages = edition.sections.map((s) => packageSection(s.id, s.articles));
    const totalKb = packages.reduce((n, p) => n + p.kb, 0);
    const audioTracks = packages.reduce((n, p) => n + p.items.filter((i) => i.audio).length, 0);

    incrementMetric('edition.download.success', { route: ROUTE });
    recordTiming('edition.download.latency', Date.now() - startTime, { route: ROUTE });

    const result = {
      success: true,
      jobId,
      editionId: edition.id,
      date: edition.date,
      articles: edition.articleCount,
      audioTracks,
      sizeMb: Math.round((totalKb / 1024) * 10) / 10,
      sections: packages.map((p) => ({ section: p.section, articles: p.items.length, kb: p.kb })),
      downloadedAt: new Date().toISOString(),
    };
    downloads.set(`${data.demoId || ''}:${edition.id}`, { status: 'downloaded', sizeMb: result.sizeMb, downloadedAt: result.downloadedAt });
    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('edition.download.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('edition.download.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Weekly edition offline download failed', {
      jobId, requestId, editionId: edition.id, error: error.message, errorClass: error.name, durationMs: duration, service: SERVICE,
    });

    if (data.alertsSuppressed) {
      error.jobId = jobId;
      throw error;
    }

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, source: 'economist-app-weekly-download', alert_path: 'instant' },
      extra: { jobId, editionId: edition.id, sections: edition.sections.map((s) => s.id) },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/43e4e1fb.js \u2014 packageSection',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: '43e4e1fb',
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      service: SERVICE,
      verticalLabel: 'The Economist app \u2014 Weekly edition offline download',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'edition', value: edition.id },
        { key: 'app_version', value: '4.62' },
        { key: 'platform', value: 'ios' },
      ],
      extra: { jobId, editionId: edition.id, sections: edition.sections.map((s) => s.id).join(','), articles: edition.articleCount },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@2026.11.4`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Economist download error', { error: err.message });
    });

    error.jobId = jobId;
    throw error;
  }
}

module.exports = {
  downloadEdition,
  listEditions,
  getEdition,
  packageSection,
  resetDownloads,
  readMinutes,
  EDITIONS,
  SECTION_PACKAGING,
  SECTION_TITLES,
  READER,
};
