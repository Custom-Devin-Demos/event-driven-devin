/**
 * Walmart Holiday Food — walmart.com/cp/holiday-food replica.
 *
 * Cart + checkout for the Thanksgiving content page. Items on the page come
 * from the "Friendsgiving favorites", "Thanksgiving staples $3 & under" and
 * "Big meal = big cleanup" carousels. Every line is priced through the
 * sales-unit pricing table so weighted items (sold per lb, charged on the
 * average weight at pick) and fixed-price items share one checkout path.
 *
 * Alerts on this vertical carry a Quantum Metric experience signal (session
 * replay, rage clicks, conversion drop) alongside the Sentry event.
 */
const Sentry = require('@sentry/node');
const { createSessionAndAlert } = require('../devin-session');
const logger = require('../../telemetry/logger');

const CUSTOMER = '03832d06';
const SERVICE = 'walmart-holiday-food-checkout';
const ROUTE = 'POST /api/03832d06/checkout';
const CULPRIT = 'app/services/verticals/03832d06.js \u2014 priceLine';

const TAX_RATE = 0.0825;
const DELIVERY_FEE = 9.95;
const DELIVERY_FREE_MIN = 35;
const MAX_LINE_QTY = 12;
const MAX_CART_LINES = 40;

const STORE = {
  id: '100',
  name: 'Bentonville Supercenter',
  address: '406 S Walton Blvd, Bentonville, AR 72712',
};

const FULFILLMENT = {
  pickup: { label: 'Pickup', slot: 'Today, 5pm\u20136pm', fee: 0 },
  delivery: { label: 'Delivery', slot: 'Today, 6pm\u20137pm', fee: DELIVERY_FEE },
};

/**
 * Sales-unit pricing rules, keyed by the catalog's `salesUnitType`.
 * `estimateLb` says whether the line is charged on an estimated weight
 * (and shows the "avg price" condition on the page).
 */
const UNIT_PRICING = {
  EACH: { label: 'each', estimateLb: false, priceCondition: '' },
  MULTIPACK: { label: 'pack', estimateLb: false, priceCondition: '' },
};

/** Weighted items are sold by the pound; the page shows the average line price. */
const WEIGHTED_ITEMS = {
  996282298: { salesUnitType: 'WEIGHT', avgWeightLb: 14.2, pricePerLb: 1.98 },
};

const CATALOG = [
  { id: '996282298', name: 'Shady Brook Farms\u00ae No Antibiotics Ever Whole Turkey, Frozen, 1 Count, 10 - 16 lbs, Serves 7 - 11 people*', price: 28.12, unit: '$1.98/lb', shelf: 'friendsgiving', image: 'https://i5.walmartimages.com/asr/e80a8d0c-dbc1-447e-95a5-d55558372990.24058d70fecf068d8fa64b56e5bee0a5.jpeg' },
  { id: '21289068', name: 'HORMEL GATHERINGS Hard Salami and Pepperoni with Cheese and Crackers, Refrigerated, 28 oz Plastic Tray', price: 14.76, unit: '52.7 \u00a2/oz', shelf: 'friendsgiving', image: 'https://i5.walmartimages.com/asr/455047c8-f932-4fe2-b9fd-8b50ca8ed359.a3ea3e8bbab0e2c94c9b6bfbb5aa9fd0.jpeg' },
  { id: '191420088', name: 'Josh Cellars Cabernet Sauvignon California Red Wine, 750 mL Bottle, 13.50% ABV', price: 10.97, unit: '43.2 \u00a2/fl oz', flag: 'Best seller', shelf: 'friendsgiving', image: 'https://i5.walmartimages.com/asr/dad362cb-7f33-4d94-9623-e8e61c13356c.41a4324f137b02a64b6fcb6cddf84f7a.jpeg' },
  { id: '10313598', name: 'Stove Top Turkey Stuffing Mix Side Dish, 6 oz Box', price: 1.88, was: 2.82, flag: 'Rollback', options: true, shelf: 'friendsgiving', image: 'https://i5.walmartimages.com/seo/Stove-Top-Turkey-Stuffing-Mix-Side-Dish-6-oz-Box_b5fc1887-105c-40df-8b68-c1204d06d4a2.d36128931a48c3ad31b49dd26f720cba.jpeg' },
  { id: '39778487', name: 'Idahoan Buttery Homestyle Mashed Potatoes Family Size Pantry Food, 8 oz', price: 2.52, was: 2.82, flag: 'Best seller', options: true, shelf: 'friendsgiving', image: 'https://i5.walmartimages.com/seo/Idahoan-Buttery-Homestyle-Mashed-Family-Size-8-oz-Pouch_0a671add-3c10-4977-ad8d-2f0c473ee467.790818fd94bcbfbf5de6ecca05f3ddca.jpeg' },
  { id: '949906404', name: 'Great Value Cooked Medium Shrimp Ring with Cocktail Sauce, 16 OZ, Frozen', price: 8.98, shelf: 'friendsgiving', image: 'https://i5.walmartimages.com/seo/Sam-s-Choice-Premium-Cooked-Medium-Shrimp-Cocktail-Ring-with-Sauce-16-oz-Frozen_6e274578-40d0-471a-8408-8be15fa6b4ce.d424229fe7ab99cb243dd83325f707c9.jpeg' },
  { id: '10421746', name: 'King\'s Hawaiian Savory Butter Rolls 12 Count, 12 oz, Shelf-Stable', price: 2.96, was: 4.48, flag: 'Best seller', shelf: 'friendsgiving', image: 'https://i5.walmartimages.com/seo/King-s-Hawaiian-Savory-Butter-Rolls-12-Count-12-oz_5daa0a47-baf8-4ac2-9ad8-b023097ef3b0.60763efb41c32d09c6fb559c67e2e0d6.png' },
  { id: '47770098', name: 'Bob Evans Gluten-Free Family Size Original Mashed Potatoes, 32 oz Tray', price: 4.98, unit: '15.6 \u00a2/oz', flag: 'Best seller', shelf: 'friendsgiving', image: 'https://i5.walmartimages.com/asr/0f8d8a0b-9fc6-4aa8-8b6f-79ee3dd94cc4.3f4f0c78f20fc83f315fb04e0103a43e.jpeg' },
  { id: '1820059583', name: 'Marketside Ready to Heat Classic Macaroni & Cheese Tray, 20 oz, Refrigerated', price: 2.97, options: true, shelf: 'friendsgiving', image: 'https://i5.walmartimages.com/seo/Marketside-Ready-to-Heat-Classic-Macaroni-Cheese-Tray-20-oz-Refrigerated_2a1a16b8-d12e-4b2b-b486-5683d5e926c6.bacb28448b65ea73ac5d675a6b9bdabf.jpeg' },
  { id: '37915367', name: 'Marketside Premium Heatable Spinach Artichoke Dip Small Tub, 16 oz, 1 Count (Refrigerated)', price: 5.84, unit: '36.5 \u00a2/oz', flag: 'Best seller', shelf: 'friendsgiving', image: 'https://i5.walmartimages.com/asr/bff6efa3-8d04-444f-a7b5-fc2a30291390.6815e51864d95e090fed917a40cdd3d7.jpeg' },
  { id: '10811208', name: 'Marie Callender\'s Pumpkin Pie, Ready to Bake Frozen Dessert, 36 oz. (frozen)', price: 5.92, was: 7.32, unit: '16.4 \u00a2/oz', flag: 'Rollback', shelf: 'friendsgiving', image: 'https://i5.walmartimages.com/asr/d89bc75e-0725-4f7c-98e9-49dcdd1a0d4b.cbf94481b1ea505c864ee926d6fcd3e0.jpeg' },
  { id: '10402988', name: 'Great Value Frozen Whipped Topping, White, 16 oz', price: 2.27, unit: '14.2 \u00a2/oz', flag: 'Best seller', shelf: 'friendsgiving', image: 'https://i5.walmartimages.com/asr/602d3a48-0eda-41fb-911a-00a192147852.be688ad6e9292421e2da40dcc3ad6b8d.jpeg' },
  { id: '10307749', name: 'Martinelli\'s Gold Medal Sparkling Apple Cider with 100% Pure Juice, 25.4 fl oz', price: 3.78, was: 3.98, options: true, shelf: 'friendsgiving', image: 'https://i5.walmartimages.com/seo/Martinelli-s-Gold-Medal-Sparkling-Apple-Cider-with-100-Pure-Juice-25-4-fl-oz_bf398286-97ca-43ec-ae43-74131905f3e0.3f3f9200a407b082ee836513d1943936.jpeg' },
  { id: '14089472', name: 'Litehouse Homestyle Ranch Dressing & Dip, 20 fl oz', price: 6.12, flag: 'Best seller', shelf: 'friendsgiving', image: 'https://i5.walmartimages.com/seo/Litehouse-Homestyle-Ranch-Refrigerated-Salad-Dressing-Dip-20-Fluid-oz-Bottle_d0d458d8-11af-4448-86e1-90b16ede779e.78154ea5c8cf00182880743016747752.jpeg' },
  { id: '15914054', name: 'Fresh Vegetable Medley Blend, 32 oz', price: 5.98, unit: '18.7 \u00a2/oz', shelf: 'friendsgiving', image: 'https://i5.walmartimages.com/asr/4cfde9ea-2a6d-4825-b2b1-4659a1e745ab.1dc4a32b5930ef445100846cf09f8b19.jpeg' },
  { id: '17057450051', name: 'Marketside Vegetable Tray 40oz', price: 11.97, unit: '29.9 \u00a2/oz', flag: 'Best seller', shelf: 'friendsgiving', image: 'https://i5.walmartimages.com/asr/f69bb651-2b2d-41b7-9bb4-5776d12c39cc.02021384f1e9aaa03c4b226b99fe8590.jpeg' },
  { id: '11964847', name: 'Stove Top Savory Herbs Stuffing Mix Side Dish, 6 oz Box', price: 1.88, was: 2.82, flag: 'Rollback', options: true, shelf: 'staples', image: 'https://i5.walmartimages.com/seo/Stove-Top-Savory-Herbs-Stuffing-Mix-Side-Dish-6-oz-Box_a035a1c5-8913-4041-a106-e3decf996868.2accf21ad031c83454aeee19a47a5427.jpeg' },
  { id: '10447837', name: 'Fresh Whole Russet Potatoes , 5 lb Bag', price: 2.47, unit: '49.4 \u00a2/lb', flag: 'Rollback', shelf: 'staples', image: 'https://i5.walmartimages.com/asr/39e383c7-abe5-42fa-9078-5d6d0bb5c0d4.8fc19a526bf85bd640d369c4c85a2bf2.jpeg' },
  { id: '50228527', name: 'Great Value Baked Buttery Round Crackers, 13.7 oz', price: 2.48, was: 2.86, flag: 'Rollback', options: true, shelf: 'staples', image: 'https://i5.walmartimages.com/seo/Great-Value-Baked-Buttery-Round-Crackers-13-7-oz_f7ab9349-a437-4de5-b515-fe692fa38910.c69f64f5a610d1103fe37dbc1f87021c.jpeg' },
  { id: '10452429', name: 'Great Value Cream Cheese Brick, 8 oz Block', price: 1.56, unit: '19.5 \u00a2/oz', flag: 'Best seller', shelf: 'staples', image: 'https://i5.walmartimages.com/asr/8e927225-b691-427b-82ad-7782a066a8e1.8c98ad54e98e16a3f890af30cc082ef1.jpeg' },
  { id: '15240706', name: 'Ocean Spray\u00ae Jellied Cranberry Sauce, Canned Side Dish, 14 oz Can', price: 1.97, was: 2.58, flag: 'Best seller', options: true, shelf: 'staples', image: 'https://i5.walmartimages.com/seo/Ocean-Spray-Jellied-Cranberry-Sauce-Canned-Side-Dish-14-oz-Can_a5cf3186-d4d4-4d76-b14e-9d5fa496789d.27e14df219f1d66dc18f678fe7dee300.jpeg' },
  { id: '132720824', name: 'Sweet Potatoes Whole Fresh, 3 lb Bag', price: 2.94, was: 4.24, unit: '98.0 \u00a2/lb', flag: 'Rollback', shelf: 'staples', image: 'https://i5.walmartimages.com/asr/0218f5c6-0364-4d86-b0d0-28887458f17e.da73ef9eb619a403b92227d9a31a8e8a.jpeg' },
  { id: '10448401', name: 'Great Value Butter Flavor Flaky Jumbo Biscuits, 8 Count', price: 1.84, unit: '11.5 \u00a2/oz', flag: 'Best seller', shelf: 'staples', image: 'https://i5.walmartimages.com/asr/eb9793fe-2019-4516-b906-f4be2ac41ab3.fcdd77fe290cde4da245e3d3848219b9.jpeg' },
  { id: '10308946', name: 'McCormick No Artificial Flavors Au Jus Gravy Seasoning Mix, 1.0 oz Packet', price: 1.56, flag: 'Best seller', options: true, shelf: 'staples', image: 'https://i5.walmartimages.com/seo/McCormick-No-Artificial-Flavors-Au-Jus-Gravy-Seasoning-Mix-1-oz-Envelope_0e6776ea-4a97-4ec7-960b-8927567b17b4.bcaa389699e0acb0c8fbba25e21feb4b.jpeg' },
  { id: '344728564', name: 'Marketside Fresh Cauliflower Florets, 12 oz', price: 2.47, unit: '20.6 \u00a2/oz', shelf: 'staples', image: 'https://i5.walmartimages.com/asr/0c6b8a74-e546-4804-bf83-2b35c98aa1b2.5265d9b1455c737239360c6e19cedbbd.jpeg' },
  { id: '5802667516', name: 'Kinder\'s Crispy Fried Onion Original Recipe, 4.5 oz', price: 2.97, was: 4.17, unit: '66.0 \u00a2/oz', flag: 'Rollback', shelf: 'staples', image: 'https://i5.walmartimages.com/asr/0651879a-8631-452a-9bc4-fbb200920035.a0ad59701856a4a64c446ee0648417a1.jpeg' },
  { id: '9031468334', name: 'Stouffer\'s Macaroni and Cheese Meal, Supreme Shells and Cheese, Three Cheese Sauce, Boxed Mac and Cheese Pasta Dinner Kit, 12 oz', price: 2.92, was: 3.26, flag: 'Rollback', options: true, shelf: 'staples', image: 'https://i5.walmartimages.com/seo/Stouffer-s-Supreme-Shells-and-Cheese-Three-Cheese-Boxed-Mac-Cheese-Dinner-Kit-12-oz_38ecd600-74c8-413d-b2bd-88fab122aaeb.09ce85f1411a089f60a411e8a12a6fe9.jpeg' },
  { id: '10801133', name: 'Cool Whip Original Whipped Cream Topping, 8 oz Tub', price: 2.08, unit: '26.0 \u00a2/oz', shelf: 'staples', image: 'https://i5.walmartimages.com/asr/d4ad4e30-474f-4b05-be5d-8234278bf0b2.5785c2333eb5e755c1e09b1b18252056.jpeg' },
  { id: '12329735', name: 'Great Value Cookies & Cream Ice Cream, 48 fl oz', price: 2.48, was: 3.27, unit: '5.2 \u00a2/fl oz', flag: 'Rollback', shelf: 'staples', image: 'https://i5.walmartimages.com/asr/a6304d21-ede8-4fde-a84c-28d89869ceda.48e970b8e3cadaa149c6c6cda553e768.jpeg' },
  { id: '24538777', name: 'Great Value 100% Pure Pumpkin, 15 oz', price: 1.16, was: 1.96, flag: 'Rollback', options: true, shelf: 'staples', image: 'https://i5.walmartimages.com/seo/Great-Value-100-Pure-Pumpkin-15-oz_fcc229e5-fadd-412f-9140-da250f7eec3d.58fc7e3eafad62591a44c688c00200b9.png' },
  { id: '10450339', name: 'Great Value Heavy Whipping Cream, 16 oz Carton, Refrigerated', price: 2.78, unit: '17.4 \u00a2/fl oz', flag: 'Rollback', shelf: 'staples', image: 'https://i5.walmartimages.com/asr/1045c3ae-6f22-45df-b271-ac26ee21dff0_2.98baf618acab7c5c605d0b7931ad8e41.jpeg' },
  { id: '265765935', name: 'Pillsbury Creamy Supreme Cream Cheese Frosting, 16 oz Tub', price: 1.76, was: 2.08, flag: 'Rollback', options: true, shelf: 'staples', image: 'https://i5.walmartimages.com/seo/Pillsbury-Creamy-Supreme-Cream-Cheese-Frosting-16-Oz-Tub_2d81ed59-c495-4a77-8db4-7c4b1901311d.143d0e6107e5ae971b929c3aee1597bb.jpeg' },
  { id: '10315012', name: 'Great Value Light Brown Sugar, 32 oz', price: 2.17, was: 2.44, flag: 'Rollback', options: true, shelf: 'staples', image: 'https://i5.walmartimages.com/seo/Great-Value-Light-Brown-Sugar-32-oz_07d1a739-5168-48aa-8469-5c9dd80ae574.8fb9eb356db160eb5c7d2cbfb6272e8e.jpeg' },
  { id: '16504401', name: 'Pillsbury Premade Refrigerated Pie Crust, Two Pie Crusts, 14.1 oz', price: 2.97, was: 4.26, unit: '21.1 \u00a2/oz', flag: 'Rollback', shelf: 'staples', image: 'https://i5.walmartimages.com/asr/8d9d47f8-3011-488b-a97e-94c19634918f.18adeb014977300ec5590545cd59ccb5.jpeg' },
  { id: '11997749', name: 'Great Value Apple Pie Filling or Topping, 21 oz', price: 2.44, flag: 'Best seller', options: true, shelf: 'staples', image: 'https://i5.walmartimages.com/seo/Great-Value-Apple-Pie-Filling-or-Topping-21-oz_92847038-5582-4001-b569-1869d911717b.d622bd7f9daf782b685790d37265c12e.jpeg' },
  { id: '40775790', name: 'Marketside Bake at Home Twin Demi Baguette, 12 oz, 2 Count', price: 1.98, unit: '16.5 \u00a2/oz', flag: 'Best seller', shelf: 'staples', image: 'https://i5.walmartimages.com/asr/7b8547b2-c7af-4ee9-86c3-4a201c49a60f.5e799ba436a8857a386576a88f0c808a.jpeg' },
  { id: '5663551862', name: 'Dawn Powerwash Spray, Dish Soap, Dishwashing Liquid, Cranberry Scent, 1 Starter Kit, 16 fl oz', price: 6.24, unit: '39.0 \u00a2/fl oz', shelf: 'cleanup', image: 'https://i5.walmartimages.com/seo/Dawn-Powerwash-Spray-Dish-Soap-Dishwashing-Liquid-Cranberry-Scent-1-Starter-Kit-16-fl-oz_363265cc-dbee-4c7d-8ffe-224f9211512e.06a6ae0ec8aaf0e47642e18bc92d03c2.jpeg' },
  { id: '12322822867', name: 'Brawny Tear-a-Square 3-Ply Paper Towels, 2 Triple Rolls', price: 6.28, unit: '$2.75/100 ct', options: true, shelf: 'cleanup', image: 'https://i5.walmartimages.com/seo/Brawny-Tear-a-Square-3-Ply-Paper-Towels-2-Triple-Rolls_5a02d45e-9105-4f64-b1ef-906ac79fbd14.58503d52ad3390263345c90343b017b4.jpeg' },
  { id: '1356110581', name: 'Great Value 39-Gallon Drawstring Lawn & Leaf Trash Bags, 20 Bags', price: 8.97, unit: '44.9 \u00a2/count', options: true, shelf: 'cleanup', image: 'https://i5.walmartimages.com/seo/Great-Value-39-Gallon-Drawstring-Lawn-Leaf-Trash-Bags-20-Bags_94ceaab0-5696-421b-8486-574ddaa7a294.a9ced6ad6b7121438f6302b309a0c4a3.jpeg' },
  { id: '13172958751', name: 'Scrub Daddy Scrub Mommy Non-Scratch Cleaning Sponges, 4 Count', price: 12.48, unit: '$3.12/ea', options: true, shelf: 'cleanup', image: 'https://i5.walmartimages.com/seo/Scrub-Daddy-s-Scrub-Mommy-Colors-Non-Scratch-Dish-Scrubber-Cleaning-Sponge-Kitchen-Bathroom-Multi-Surface-Safe-Dual-Sided-Dish-Sponge-Scrubbing-Wipin_a898d677-9719-489d-a9d0-0417c8c3b08a.257b6611211afe97e7441528d0a76bac.jpeg' },
  { id: '11027237', name: 'Lysol\u00ae, All-Purpose Cleaner, Sanitizing and Disinfecting Spray, Lemon Breeze Scent, 32 oz, Bottle', price: 3.97, unit: '12.4 \u00a2/fl oz', options: true, shelf: 'cleanup', image: 'https://i5.walmartimages.com/seo/Lysol-All-Purpose-Cleaner-Sanitizing-and-Disinfecting-Spray-32-oz-Lemon-Breeze-Scent-Bottle_35364501-88d0-4c8e-9266-6160fa6c3a48.054d50d0497f61a65ac3e92f5beda44d.jpeg' },
  { id: '14786151876', name: 'Febreze Air Freshener Spray, Odor-Fighting Room Spray, Fall Mix, 8.8oz, 3 Count', price: 17.2, unit: '65.2 \u00a2/oz', shelf: 'cleanup', image: 'https://i5.walmartimages.com/seo/Febreze-Air-Freshener-Aerosol-Sprays-Mixed_b268b469-b66c-415d-b14c-a9c63314df84.2a0a487e0b976fc3cce4b1b699a4db0a.jpeg' },
  { id: '16759055075', name: 'Great Value Original Dishwasher Pacs, Fresh Scent, 115 Count', price: 14.64, unit: '26.8 \u00a2/oz', shelf: 'cleanup', image: 'https://i5.walmartimages.com/seo/Great-Value-Automatic-Dishwasher-Pacs-Fresh-Scent-115-Count_64b64236-eeee-49de-b59a-8e997b43a084.ccbdcfafb6539d8711751b6a6ce9b9e8.jpeg' },
  { id: '3485163912', name: 'Great Value Ultra Strong Paper Towels, 2 Triple Rolls', price: 6.27, unit: '$1.90/100 ct', shelf: 'cleanup', image: 'https://i5.walmartimages.com/seo/Great-Value-Ultra-Strong-Paper-Towels-2-Triple-Rolls_d083a87e-c79f-4a81-a861-cb72a0bba410.ea640cb61247e204bfe593bafb4f1172.jpeg' },
].map((p) => ({ salesUnitType: 'EACH', ...p, ...(WEIGHTED_ITEMS[p.id] || {}) }));

const SHELVES = [
  { key: 'staples', title: 'Thanksgiving staples $3 & under', link: 'Shop all' },
  { key: 'friendsgiving', title: 'Friendsgiving favorites', link: 'Shop all' },
  { key: 'cleanup', title: 'Big meal = big cleanup', subtitle: 'Stock up on supplies.', link: 'View all' },
];

const REMEDIATION_DIRECTIVE = [
  'Remediation directive for this Walmart Holiday Food checkout incident:',
  '1. Reproduce with the Friendsgiving cart that includes the Shady Brook Farms whole turkey (item 996282298) and confirm the TypeError in priceLine.',
  '2. Fix forward in app/services/verticals/03832d06.js so weighted (per-lb) items price on their average weight instead of crashing; do not remove the turkey from the catalog or the carousel.',
  '3. Keep fixed-price items unchanged and preserve the savings / tax / fee math (see tests/03832d06-checkout.test.js).',
  '4. Add a regression test that a cart with a WEIGHT sales unit checks out successfully.',
  '5. Open a PR and post the link in the Slack alert thread, citing the Quantum Metric session replay from the alert as the customer-impact evidence.',
].join('\n');

class CheckoutError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'CheckoutError';
    this.code = code;
    this.status = status;
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function findProduct(id) {
  return CATALOG.find((p) => p.id === String(id));
}

/**
 * Quantum Metric captures every walmart.com session; this is the hardcoded
 * experience signal the alert carries so responders see customer impact
 * (session replay, rage clicks, conversion) next to the stack trace.
 */
function buildQuantumMetricSignal(orderId) {
  const seed = orderId.replace(/\D/g, '').slice(-6) || '418260';
  const sessionId = `qm-${seed}-f2a9c1`;
  return {
    source: 'Quantum Metric',
    sessionId,
    replayUrl: `https://walmart.quantummetric.com/#/replay/${sessionId}?event=api_error_500&page=cp%2Fholiday-food`,
    dashboardUrl: 'https://walmart.quantummetric.com/#/dashboard/holiday-food-checkout',
    event: 'API Error 500 \u2014 POST /api/03832d06/checkout',
    segment: 'Holiday Food CP \u2192 Cart \u2192 Continue to checkout',
    rageClickTarget: 'Continue to checkout',
    affectedSessions: '1,284',
    rageClicks: 312,
    errorRate: '18.6%',
    conversionDrop: '\u221223.4% vs. 7-day baseline',
    revenueAtRisk: '$142K/hr',
    window: 'last 15 min',
  };
}

function normalizeItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new CheckoutError('Your cart is empty.', 'EMPTY_CART');
  }
  if (items.length > MAX_CART_LINES) {
    throw new CheckoutError(`Carts are limited to ${MAX_CART_LINES} items.`, 'TOO_MANY_LINES');
  }
  return items.map((line) => {
    const product = findProduct(line && line.id);
    if (!product) {
      throw new CheckoutError(`Item ${line && line.id} is not available at ${STORE.name}.`, 'UNKNOWN_PRODUCT');
    }
    const qty = line.qty === undefined ? 1 : Number(line.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_LINE_QTY) {
      throw new CheckoutError(`Quantity for ${product.name} must be between 1 and ${MAX_LINE_QTY}.`, 'BAD_QTY');
    }
    return { product, qty };
  });
}

/**
 * Price one cart line through the sales-unit rule. Weighted items are charged
 * on the average weight at pick; fixed-price items on the shelf price.
 */
function priceLine({ product, qty }) {
  const rule = UNIT_PRICING[product.salesUnitType];
  const unitPrice = rule.estimateLb
    ? round2(product.avgWeightLb * product.pricePerLb)
    : product.price;
  const lineTotal = round2(unitPrice * qty);
  const savings = product.was ? round2((product.was - product.price) * qty) : 0;
  return {
    id: product.id,
    name: product.name,
    qty,
    unitPrice,
    lineTotal,
    savings,
    priceCondition: rule.priceCondition,
    salesUnit: rule.label,
  };
}

function reportFailure(error, context) {
  const quantumMetric = buildQuantumMetricSignal(context.orderId);
  Sentry.captureException(error, {
    tags: {
      route: ROUTE,
      service: SERVICE,
      customer: CUSTOMER,
      fulfillment: context.fulfillment,
      experience_monitor: 'quantum-metric',
      alert_path: 'instant',
    },
    extra: { ...context, quantumMetric },
  });
  logger.info('Posting alert and triggering Devin', { service: SERVICE, quantumMetricSession: quantumMetric.sessionId, ...context });
  createSessionAndAlert({
    issueTitle: `${error.name}: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: CULPRIT,
    errorType: error.name || 'Error',
    errorValue: error.message,
    devinUserId: context.devinUserId,
    devinEmail: context.devinEmail,
    devinOrgId: context.devinOrgId,
    service: SERVICE,
    verticalLabel: 'Walmart Holiday Food Checkout',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: CUSTOMER,
    quantumMetric,
    level: 'error',
    platform: 'node',
    environment: 'prod',
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'fulfillment', value: context.fulfillment },
      { key: 'experience_monitor', value: 'quantum-metric' },
    ],
    extra: {
      orderId: context.orderId,
      items: context.items,
      quantumMetric,
    },
  }).catch((err) => {
    logger.error('Failed to create Devin session for Walmart checkout error', {
      error: err.message,
      orderId: context.orderId,
    });
  });
  return quantumMetric;
}

/**
 * Place the cart as a pickup or delivery order.
 * @param {{items: Array<{id: string, qty?: number}>, fulfillment?: string, wplus?: boolean,
 *          devinUserId?: string, devinOrgId?: string, devinEmail?: string}} data
 */
async function placeOrder(data = {}) {
  const lines = normalizeItems(data.items);
  const fulfillmentKey = data.fulfillment || 'pickup';
  const fulfillment = FULFILLMENT[fulfillmentKey];
  if (!fulfillment) {
    throw new CheckoutError('Choose pickup or delivery.', 'BAD_FULFILLMENT');
  }
  const orderId = `WM-${Date.now().toString(36).toUpperCase()}-${String(Math.floor(Math.random() * 9000) + 1000)}`;
  const context = {
    orderId,
    fulfillment: fulfillmentKey,
    items: lines.map((l) => ({ id: l.product.id, qty: l.qty, salesUnitType: l.product.salesUnitType })),
    devinUserId: data.devinUserId,
    devinOrgId: data.devinOrgId,
    devinEmail: data.devinEmail,
  };

  let priced;
  try {
    priced = lines.map(priceLine);
  } catch (error) {
    const quantumMetric = reportFailure(error, context);
    error.status = 500;
    error.code = 'CHECKOUT_FAILED';
    error.quantumMetric = { sessionId: quantumMetric.sessionId, replayUrl: quantumMetric.replayUrl };
    throw error;
  }

  const subtotal = round2(priced.reduce((sum, l) => sum + l.lineTotal, 0));
  const savings = round2(priced.reduce((sum, l) => sum + l.savings, 0));
  const fee = fulfillmentKey === 'delivery' && !data.wplus && subtotal < DELIVERY_FREE_MIN ? fulfillment.fee : 0;
  const tax = round2(subtotal * TAX_RATE);
  const total = round2(subtotal + fee + tax);
  const itemCount = priced.reduce((sum, l) => sum + l.qty, 0);

  logger.info('Walmart holiday food order placed', { orderId, fulfillment: fulfillmentKey, itemCount, total });
  return {
    success: true,
    orderId,
    store: STORE,
    fulfillment: { type: fulfillmentKey, label: fulfillment.label, slot: fulfillment.slot },
    lines: priced,
    itemCount,
    subtotal,
    savings,
    fee,
    tax,
    total,
  };
}

module.exports = {
  placeOrder,
  priceLine,
  buildQuantumMetricSignal,
  CATALOG,
  SHELVES,
  STORE,
  FULFILLMENT,
  UNIT_PRICING,
  WEIGHTED_ITEMS,
  TAX_RATE,
  DELIVERY_FEE,
  DELIVERY_FREE_MIN,
  MAX_LINE_QTY,
  MAX_CART_LINES,
  REMEDIATION_DIRECTIVE,
  CheckoutError,
};
