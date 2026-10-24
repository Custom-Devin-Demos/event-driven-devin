const IMAGE_BASE = 'https://www1.bac-assets.com/hp-assets/spa-assets/images/assets-images-site-hp-assets-mastheads-consumer-cards-en-4-card-';

const CARD_PRODUCTS = [
  {
    productId: 'customized-cash-rewards',
    name: 'Customized Cash Rewards',
    network: 'visa',
    tier: 'Signature',
    campaignId: '5779014',
    headline: '6% choice category cash back offer',
    bonus: { kind: 'cash', amount: 200, label: 'online bonus offer', spend: 1000, windowDays: 90 },
    image: `${IMAGE_BASE}5779014_Customized_1.webp`,
  },
  {
    productId: 'unlimited-cash-rewards',
    name: 'Unlimited Cash Rewards',
    network: 'visa',
    tier: 'Signature',
    campaignId: '8949901',
    headline: '1.5% unlimited cash back on purchases',
    bonus: { kind: 'cash', amount: 250, label: 'online bonus offer', spend: 1000, windowDays: 90 },
    image: `${IMAGE_BASE}card_mh_un_8949901_e.webp`,
  },
  {
    productId: 'travel-rewards',
    name: 'Travel Rewards',
    network: 'visa',
    tier: 'Signature',
    campaignId: '5779014',
    headline: 'Unlimited 1.5 points for every $1 spent on all purchases',
    bonus: { kind: 'points', amount: 25000, label: 'online bonus points offer', spend: 1000, windowDays: 90 },
    image: `${IMAGE_BASE}5779014_Travel_3.webp`,
  },
  {
    productId: 'bankamericard',
    name: 'BankAmericard®',
    network: 'visa',
    tier: 'Platinum Plus',
    campaignId: '5779014',
    headline: 'Intro APR offer for 21 billing cycles',
    bonus: { kind: 'intro-apr', amount: 0, label: 'intro APR offer', cycles: 21 },
    image: `${IMAGE_BASE}5779014_Nonrewards_4.webp`,
  },
];

function listProducts() {
  return CARD_PRODUCTS.map((p) => ({
    productId: p.productId, name: p.name, headline: p.headline, bonus: p.bonus, image: p.image,
  }));
}

function getProduct(productId) {
  return CARD_PRODUCTS.find((p) => p.productId === productId) || null;
}

module.exports = { CARD_PRODUCTS, listProducts, getProduct };
