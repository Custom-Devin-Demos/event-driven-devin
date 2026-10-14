const CACHE_PROFILES = {
  hot: {
    concurrency: 32,
    partSizeMb: 16,
    ttlHours: 24,
    retry: { attempts: 5, backoffMs: [200, 400, 800, 1600] },
  },
  standard: {
    concurrency: 16,
    partSizeMb: 32,
    ttlHours: 72,
    retry: { attempts: 4, backoffMs: [500, 1000, 2000] },
  },
  bulk: {
    concurrency: 8,
    partSizeMb: 64,
    ttlHours: 168,
    retry: { attempts: 3, backoffMs: [1000, 4000] },
  },
};

function resolveProfile(name) {
  const profile = CACHE_PROFILES[name] || CACHE_PROFILES.standard;
  return {
    name: CACHE_PROFILES[name] ? name : 'standard',
    concurrency: profile.concurrency,
    partSizeMb: profile.partSizeMb,
    ttlHours: profile.ttlHours,
    retry: { ...profile.retry, backoffMs: [...profile.retry.backoffMs] },
  };
}

function listProfiles() {
  return Object.keys(CACHE_PROFILES).map((name) => resolveProfile(name));
}

module.exports = { CACHE_PROFILES, resolveProfile, listProfiles };
