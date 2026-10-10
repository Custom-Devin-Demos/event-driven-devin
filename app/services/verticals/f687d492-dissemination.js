const DISTRIBUTION_CHANNELS = [
  {
    id: 'exchange-settlement',
    label: 'Exchange settlement values',
    audience: 'Cboe · CME Group · options & futures settlement',
    recipients: 4,
    deadline: '16:20 ET',
    format: 'Settlement message (FIXML)',
    critical: true,
  },
  {
    id: 'vendor-feed',
    label: 'Market data vendor feed',
    audience: 'Bloomberg · LSEG · FactSet · ICE Data Services',
    recipients: 41,
    deadline: '16:30 ET',
    format: 'Real-time index feed (FIX)',
    critical: true,
  },
  {
    id: 'eod-index-file',
    label: 'End-of-day index file',
    audience: 'ETF issuers · index fund managers · custodians',
    recipients: 312,
    deadline: '17:15 ET',
    format: 'CSV over SFTP',
    critical: true,
  },
  {
    id: 'public-web',
    label: 'Public index pages',
    audience: 'spglobal.com/spdji · press · retail investors',
    recipients: 1,
    deadline: '17:30 ET',
    format: 'JSON (CDN)',
    critical: false,
  },
];

const BYTES_PER_LEVEL = {
  'exchange-settlement': 412,
  'vendor-feed': 1860,
  'eod-index-file': 24380,
  'public-web': 9120,
};

function manifestIdFor(tradeDate) {
  return `EOD-${tradeDate.replace(/-/g, '')}-US`;
}

function buildDistributionManifest(levels, priceSets, tradeDate) {
  const priced = priceSets.reduce((sum, set) => sum + set.priced.length, 0);
  const missing = priceSets.reduce((sum, set) => sum + set.missing.length, 0);
  return {
    manifestId: manifestIdFor(tradeDate),
    tradeDate,
    builtAt: new Date().toISOString(),
    levels: levels.map((level) => ({
      indexId: level.indexId,
      ticker: level.ticker,
      officialClose: level.officialClose,
      changePct: level.changePct,
    })),
    coverage: { priced, missing },
    deliveries: DISTRIBUTION_CHANNELS.map((channel) => ({
      channelId: channel.id,
      label: channel.label,
      recipients: channel.recipients,
      deadline: channel.deadline,
      payloadBytes: BYTES_PER_LEVEL[channel.id] * levels.length,
      status: 'queued',
    })),
  };
}

function releaseToChannels(manifest) {
  const releasedAt = new Date().toISOString();
  return manifest.deliveries.map((delivery) => ({
    ...delivery,
    status: 'delivered',
    deliveredAt: releasedAt,
  }));
}

module.exports = {
  DISTRIBUTION_CHANNELS,
  buildDistributionManifest,
  releaseToChannels,
};
