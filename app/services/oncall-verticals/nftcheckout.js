const crypto = require('crypto');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { simulateFulfillAvailableAdvancedOrders } = require('./nftcheckout-seaport');

const FULFILLMENT_ROUTE = '/api/oncall/nftcheckout/fulfillment';
const SERVICE = 'checkout-api';
const DISPLAY_SERVICE = 'os-fulfillment-api';
const RELEASE = 'os-fulfillment-api@2026.10.26';
const MAX_ITEMS = 10;
const WEI_PER_ETH = 10n ** 18n;
const PREFLIGHT_LATENCY_MS = [220, 420];

/**
 * Seaport deployment the transaction targets. Before the wallet prompt the
 * bundle is preflighted in-process (./nftcheckout-seaport.js) with the same
 * fulfillment rules, so nothing reaches the chain unless it would settle.
 */
const SEAPORT_DEPLOYMENT = {
  protocol: 'Seaport 1.6',
  preflight: 'in-process (app/services/oncall-verticals/nftcheckout-seaport.js)',
  chain: 'Base Sepolia (testnet)',
  chainId: 84532,
  address: '0x0000000000000068F116a894984e2DB1123eB395',
};

const ITEM_TYPE = { NATIVE: 0, ERC721: 2 };
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
/** Illustrative connected wallet that signs and funds the purchase. */
const BUYER_WALLET = '0xb0b0000000000000000000000000000000c0ffee';

/** Illustrative collection: fictional art, sellers and wallets. */
const COLLECTION = {
  slug: 'puffy-penguins-demo',
  name: 'Puffy Penguins',
  contract: '0x5e1f0000000000000000000000000000000d3e70',
  creatorFeeBps: 500,
  creatorFeeRecipient: '0xc4ea70700000000000000000000000000000fee5',
  marketplaceFeeBps: 0,
};

const TRAITS = {
  background: ['Blue', 'Mint', 'Peach', 'Lavender', 'Sky', 'Coral'],
  body: ['Turtleneck', 'Hoodie', 'Lei', 'Overalls', 'Scarf', 'Puffer'],
  face: ['Content', 'Wink', 'Shades', 'Monocle', 'Blush', 'Stache'],
  head: ['Beanie', 'Helmet', 'Afro', 'Sombrero', 'Crown', 'Bear Hood'],
};

function seeded(tokenId, salt) {
  return crypto.createHash('sha256').update(`${COLLECTION.slug}:${tokenId}:${salt}`).digest().readUInt32BE(0);
}

function buildListings() {
  const ids = [3102, 102, 8817, 4409, 6921, 7740, 1563, 2290, 5048, 6311, 7188, 845, 1977, 3456, 4120, 5775, 6602, 8001];
  return ids.map((tokenId, i) => {
    const pick = (key) => TRAITS[key][seeded(tokenId, key) % TRAITS[key].length];
    // Prices in milli-ETH so totals stay exact.
    const priceMilli = 9850 + i * 15 + (seeded(tokenId, 'price') % 4) * 5;
    return {
      tokenId,
      name: `Puffy Penguin #${tokenId}`,
      rarity: 1 + (seeded(tokenId, 'rarity') % 8888),
      priceEth: priceMilli / 1000,
      lastSaleEth: (priceMilli - 120 + (seeded(tokenId, 'last') % 300)) / 1000,
      seller: `0x${crypto.createHash('sha256').update(`seller:${tokenId}`).digest('hex').slice(0, 40)}`,
      traits: { background: pick('background'), body: pick('body'), face: pick('face'), head: pick('head') },
    };
  });
}

const LISTINGS = buildListings();
const LISTINGS_BY_ID = new Map(LISTINGS.map((l) => [l.tokenId, l]));

const delay = ([minMs, maxMs]) => new Promise((resolve) => {
  setTimeout(resolve, minMs + Math.random() * (maxMs - minMs));
});

function invalidCheckout(message) {
  const error = new Error(message);
  error.code = 'INVALID_CHECKOUT';
  return error;
}

function toWei(eth) {
  return BigInt(Math.round(eth * 1000)) * (WEI_PER_ETH / 1000n);
}

function formatEth(wei) {
  const whole = wei / WEI_PER_ETH;
  const frac = (wei % WEI_PER_ETH).toString().padStart(18, '0').slice(0, 4).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/**
 * Seaport order for one listing: the NFT on offer, seller proceeds and the
 * creator earnings as consideration (marketplace fee is 0% on this collection).
 */
function buildOrder(listing) {
  const priceWei = toWei(listing.priceEth);
  const creatorFeeWei = (priceWei * BigInt(COLLECTION.creatorFeeBps)) / 10000n;
  return {
    offerer: listing.seller,
    offer: [{ itemType: ITEM_TYPE.ERC721, token: COLLECTION.contract, identifier: listing.tokenId, amount: 1n }],
    consideration: [
      { itemType: ITEM_TYPE.NATIVE, token: ZERO_ADDRESS, identifier: 0, amount: priceWei - creatorFeeWei, recipient: listing.seller },
      { itemType: ITEM_TYPE.NATIVE, token: ZERO_ADDRESS, identifier: 0, amount: creatorFeeWei, recipient: COLLECTION.creatorFeeRecipient },
    ],
  };
}

/**
 * Fulfillment components for fulfillAvailableAdvancedOrders: one offer
 * component per NFT, and consideration items paid to the same recipient in
 * the same currency are aggregated into one transfer (e.g. creator earnings
 * across every order in a sweep).
 */
function buildFulfillments(orders) {
  const offerFulfillments = orders.map((_, orderIndex) => [{ orderIndex, itemIndex: 0 }]);
  const groups = new Map();
  orders.forEach((order, orderIndex) => {
    order.consideration.forEach((item, itemIndex) => {
      const key = `${item.itemType}:${item.token}:${item.identifier}:${item.recipient}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ orderIndex, itemIndex });
    });
  });
  return { offerFulfillments, considerationFulfillments: [...groups.values()] };
}

function validateCheckout(data) {
  const raw = Array.isArray(data.tokenIds) ? data.tokenIds : [];
  const tokenIds = [...new Set(raw.map((id) => Number(id)))];
  if (!tokenIds.length) throw invalidCheckout('Add at least one item to your cart.');
  if (tokenIds.length > MAX_ITEMS) throw invalidCheckout(`You can buy up to ${MAX_ITEMS} items at once.`);
  const listings = tokenIds.map((id) => LISTINGS_BY_ID.get(id));
  if (listings.some((l) => !l)) throw invalidCheckout('One or more items are no longer listed.');
  return { listings };
}

function seaportRevertError(revert) {
  const error = new Error(`Seaport preflight reverted: ${revert.name}(${Object.values(revert.args).join(', ')})`);
  error.name = 'SeaportRevertError';
  error.code = 'SEAPORT_REVERT';
  error.revert = revert;
  return error;
}

async function prepareFulfillment(data = {}) {
  const startedAt = Date.now();
  const { listings } = validateCheckout(data);
  const checkoutId = `CHK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const tags = { route: FULFILLMENT_ROUTE, service: SERVICE, release: RELEASE, items: String(listings.length) };
  incrementMetric('nftcheckout.fulfillment.attempt', tags);

  const orders = listings.map(buildOrder);
  const fulfillments = buildFulfillments(orders);
  const totalWei = orders.reduce((sum, o) => sum + o.consideration.reduce((s, c) => s + c.amount, 0n), 0n);
  const creatorFeesWei = orders.reduce((sum, o) => sum + o.consideration[1].amount, 0n);

  await delay(PREFLIGHT_LATENCY_MS);
  const result = simulateFulfillAvailableAdvancedOrders(orders, fulfillments, { fulfiller: BUYER_WALLET, value: totalWei });
  const durationMs = Date.now() - startedAt;

  if (result.success) {
    incrementMetric('nftcheckout.fulfillment.success', tags);
    recordTiming('nftcheckout.fulfillment.latency', durationMs, { route: FULFILLMENT_ROUTE, service: SERVICE });
    logger.info('Seaport fulfillment prepared', {
      checkoutId, items: listings.length, durationMs, service: SERVICE, route: FULFILLMENT_ROUTE, release: RELEASE,
    });
    return {
      success: true,
      checkoutId,
      items: listings.map((l) => l.tokenId),
      transaction: {
        method: listings.length > 1 ? 'fulfillAvailableAdvancedOrders' : 'fulfillAdvancedOrder',
        to: SEAPORT_DEPLOYMENT.address,
        chain: SEAPORT_DEPLOYMENT.chain,
        valueEth: formatEth(totalWei),
        gasEstimate: result.gasEstimate,
        broadcast: false,
      },
      totals: { totalEth: formatEth(totalWei), creatorEarningsEth: formatEth(creatorFeesWei) },
    };
  }

  const error = seaportRevertError(result.revert);
  error.checkoutId = checkoutId;
  incrementMetric('nftcheckout.fulfillment.reverted', { ...tags, revert: result.revert.name });
  recordTiming('nftcheckout.fulfillment.latency', durationMs, { route: FULFILLMENT_ROUTE, service: SERVICE, error: 'true' });
  logger.error('Seaport preflight reverted', {
    checkoutId,
    code: error.code,
    errorClass: error.name,
    method: 'fulfillAvailableAdvancedOrders',
    revert: result.revert.name,
    revertSelector: result.revert.selector,
    orderIndex: result.revert.args.orderIndex,
    considerationIndex: result.revert.args.considerationIndex,
    shortfallWei: result.revert.args.shortfallAmount,
    orders: orders.length,
    considerationFulfillments: fulfillments.considerationFulfillments.map((c) => c.length),
    preflight: SEAPORT_DEPLOYMENT.preflight,
    release: RELEASE,
    durationMs,
    service: SERVICE,
    route: FULFILLMENT_ROUTE,
  });
  Sentry.captureException(error, {
    tags: { route: FULFILLMENT_ROUTE, service: SERVICE, release: RELEASE, revert: result.revert.name },
    extra: { checkoutId, items: listings.map((l) => l.tokenId), revert: result.revert, seaport: SEAPORT_DEPLOYMENT },
  });
  throw error;
}

function listCollection() {
  return {
    collection: {
      name: COLLECTION.name,
      slug: COLLECTION.slug,
      chain: SEAPORT_DEPLOYMENT.chain,
      creatorFeeBps: COLLECTION.creatorFeeBps,
      marketplaceFeeBps: COLLECTION.marketplaceFeeBps,
      items: 8888,
      illustrative: true,
    },
    listings: LISTINGS.map(({ seller, ...rest }) => rest),
  };
}

module.exports = {
  prepareFulfillment,
  listCollection,
  buildOrder,
  buildFulfillments,
  simulateFulfillAvailableAdvancedOrders,
  LISTINGS,
  COLLECTION,
  SEAPORT_DEPLOYMENT,
  RELEASE,
  SERVICE,
  DISPLAY_SERVICE,
  FULFILLMENT_ROUTE,
};
