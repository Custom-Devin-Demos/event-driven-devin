// In-memory live menu for the Toast Now "86 from anywhere" demo. Fixture data only:
// unauthenticated, bounded and reset to the seed on restart or POST .../reset.
const RESTAURANTS = ['toast-trattoria'];
const SEED_ITEMS = [
  { guid: 'item-mocha', name: 'Mocha', menu: 'Breakfast Menu', group: 'Coffee', outOfStock: true },
  { guid: 'item-quesadilla', name: 'Quesadilla', menu: 'Lunch Menu', group: 'Appetizers', outOfStock: false },
  { guid: 'item-margarita', name: 'Margarita', menu: 'Dinner Menu', group: 'Cocktails', outOfStock: false },
  { guid: 'item-shrimp-enchiladas', name: 'Shrimp Enchiladas', menu: 'Dinner Menu', group: 'Entrees', outOfStock: false },
  { guid: 'item-chicken-parm', name: 'Chicken Parmesan', menu: 'Dinner Menu', group: 'Entrees', outOfStock: false },
  { guid: 'item-chicken-caesar', name: 'Chicken Caesar Salad', menu: 'Lunch Menu', group: 'Salads', outOfStock: false },
  { guid: 'item-margherita-pizza', name: 'Margherita Pizza', menu: 'Dinner Menu', group: 'Pizza', outOfStock: false },
  { guid: 'item-tiramisu', name: 'Tiramisu', menu: 'Dinner Menu', group: 'Desserts', outOfStock: false },
  { guid: 'item-espresso-martini', name: 'Espresso Martini', menu: 'Dinner Menu', group: 'Cocktails', outOfStock: false },
  { guid: 'item-lemonade', name: 'Blood Orange Lemonade', menu: 'Lunch Menu', group: 'Beverages', outOfStock: false },
];
const SEED_VERSION = 1;
const MAX_STREAMS = 20;
const MAX_SEEN_OPS = 500;
const MAX_REPLIES = 100;
const PRESENCE_TTL_MS = 30 * 1000;

function clip(value, max) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max);
}

const stores = new Map();

function freshStore() {
  return {
    version: SEED_VERSION,
    items: SEED_ITEMS.map((item) => ({ ...item })),
    seenOps: new Map(),
    replies: [],
    streams: new Set(),
    presence: new Map(),
  };
}

function getStore(restaurant) {
  if (!RESTAURANTS.includes(restaurant)) return null;
  if (!stores.has(restaurant)) stores.set(restaurant, freshStore());
  return stores.get(restaurant);
}

function presenceList(store, now = Date.now()) {
  for (const [deviceId, entry] of store.presence) {
    if (!entry.streams && now - entry.lastSeen > PRESENCE_TTL_MS) store.presence.delete(deviceId);
  }
  return [...store.presence.values()].map(({ managerName, deviceId, device }) => ({ managerName, deviceId, device }));
}

function broadcast(store, event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of store.streams) res.write(frame);
}

function snapshot(restaurant) {
  const store = getStore(restaurant);
  if (!store) return null;
  return { version: store.version, items: store.items.map((item) => ({ ...item })), presence: presenceList(store) };
}

/**
 * Applies one 86 / un-86 op. Optimistic concurrency: the op must be based on the current
 * server version, otherwise 409 STALE_MENU_VERSION with the server version so the client
 * can refetch and rebase. Replaying an opId returns the original result.
 */
function applyOp(restaurant, body) {
  const store = getStore(restaurant);
  if (!store) return { status: 404, body: { error: 'UNKNOWN_RESTAURANT' } };
  const opId = clip(body.opId, 64);
  const itemGuid = clip(body.itemGuid, 64);
  const baseVersion = Number(body.baseVersion);
  if (!opId || !itemGuid || !Number.isInteger(baseVersion) || typeof body.outOfStock !== 'boolean') {
    return { status: 400, body: { error: 'INVALID_OP' } };
  }
  if (store.seenOps.has(opId)) return { status: 200, body: { version: store.seenOps.get(opId), duplicate: true } };
  const item = store.items.find((candidate) => candidate.guid === itemGuid);
  if (!item) return { status: 404, body: { error: 'UNKNOWN_ITEM' } };
  if (baseVersion !== store.version) {
    return { status: 409, body: { error: 'STALE_MENU_VERSION', serverVersion: store.version } };
  }
  item.outOfStock = body.outOfStock;
  store.version += 1;
  store.seenOps.set(opId, store.version);
  if (store.seenOps.size > MAX_SEEN_OPS) store.seenOps.delete(store.seenOps.keys().next().value);
  broadcast(store, 'op', {
    opId,
    version: store.version,
    itemGuid,
    itemName: item.name,
    outOfStock: item.outOfStock,
    managerName: clip(body.managerName, 64),
    deviceId: clip(body.deviceId, 64),
    at: new Date().toISOString(),
  });
  return { status: 200, body: { version: store.version } };
}

function addReply(restaurant, body) {
  const store = getStore(restaurant);
  if (!store) return { status: 404, body: { error: 'UNKNOWN_RESTAURANT' } };
  const reply = {
    id: clip(body.id, 64),
    entryId: clip(body.entryId, 64),
    author: clip(body.author, 64),
    text: clip(body.text, 500).trim(),
    postedAt: clip(body.postedAt, 32),
    deviceId: clip(body.deviceId, 64),
  };
  if (!reply.id || !reply.entryId || !reply.author || !reply.text) return { status: 400, body: { error: 'INVALID_REPLY' } };
  if (!store.replies.some((existing) => existing.id === reply.id)) {
    store.replies.push(reply);
    if (store.replies.length > MAX_REPLIES) store.replies.shift();
    broadcast(store, 'reply', reply);
  }
  return { status: 200, body: { received: true } };
}

/** Attaches an SSE response. Returns false when the restaurant is unknown or full. */
function openStream(restaurant, res, who) {
  const store = getStore(restaurant);
  if (!store || store.streams.size >= MAX_STREAMS) return false;
  const deviceId = clip(who.deviceId, 64);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  store.streams.add(res);
  if (deviceId) {
    const entry = store.presence.get(deviceId) || { streams: 0 };
    store.presence.set(deviceId, {
      managerName: clip(who.managerName, 64) || 'Manager',
      deviceId,
      device: clip(who.device, 64) || 'iPhone',
      streams: entry.streams + 1,
      lastSeen: Date.now(),
    });
  }
  res.write(`event: hello\ndata: ${JSON.stringify({ version: store.version, replies: store.replies })}\n\n`);
  broadcast(store, 'presence', { presence: presenceList(store) });
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  res.on('close', () => {
    clearInterval(heartbeat);
    store.streams.delete(res);
    const entry = deviceId && store.presence.get(deviceId);
    if (entry) {
      entry.streams -= 1;
      entry.lastSeen = Date.now();
      if (entry.streams <= 0) store.presence.delete(deviceId);
    }
    broadcast(store, 'presence', { presence: presenceList(store) });
  });
  return true;
}

function reset(restaurant) {
  const store = getStore(restaurant);
  if (!store) return null;
  const fresh = freshStore();
  store.version = fresh.version;
  store.items = fresh.items;
  store.seenOps = fresh.seenOps;
  store.replies = fresh.replies;
  broadcast(store, 'reset', { version: store.version, items: store.items });
  return snapshot(restaurant);
}

module.exports = {
  RESTAURANTS, SEED_ITEMS, SEED_VERSION, MAX_STREAMS, snapshot, applyOp, addReply, openStream, reset,
};
