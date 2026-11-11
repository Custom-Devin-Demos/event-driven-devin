/**
 * Dell.com storefront demo data — mirrors config/catalog.js and
 * config/account.js in COG-GTM/dell-com-demo (the source of the hosted
 * Vite/React build). Everything here is fictional: no real products, prices,
 * customers or orders. Image paths are relative to the hosted app's base.
 */
const PRODUCTS = [
  {
    id: 'dell-14-plus',
    name: 'Dell 14 Plus Laptop',
    family: 'Dell',
    badge: 'NEW',
    tagline: 'Your style. Your color.',
    image: '/assets/dell14.png',
    priceCents: 74999,
    listPriceCents: 99999,
    rating: 4.5,
    reviews: 824,
    processor: 'Intel\u00ae Core\u2122 Ultra 7 256V',
    graphics: 'Intel\u00ae Arc\u2122 Graphics',
    display: '14.0-inch, 2.5K, 90Hz, 300 nits',
    screenSize: 14,
    colors: ['Ice Blue', 'Platinum Silver', 'Sandstone'],
  },
  {
    id: 'dell-15',
    name: 'Dell 15 Laptop',
    family: 'Dell',
    badge: 'LIMITED-TIME OFFER',
    tagline: 'Everyday essentials. Extraordinary value.',
    image: '/assets/dell15.png',
    priceCents: 44999,
    listPriceCents: 59999,
    rating: 4.3,
    reviews: 1632,
    processor: 'Intel\u00ae Core\u2122 i5-1334U',
    graphics: 'Intel\u00ae UHD Graphics',
    display: '15.6-inch, FHD, 120Hz, 250 nits',
    screenSize: 15,
    colors: ['Carbon Black', 'Platinum Silver'],
  },
  {
    id: 'dell-16',
    name: 'Dell 16 Laptop',
    family: 'Dell',
    badge: 'TOP RATED',
    tagline: 'A bigger view of everything you love.',
    image: '/assets/dell16.png',
    priceCents: 64999,
    listPriceCents: 79999,
    rating: 4.6,
    reviews: 512,
    processor: 'AMD Ryzen\u2122 7 250',
    graphics: 'AMD Radeon\u2122 Graphics',
    display: '16.0-inch, FHD+, 60Hz, 300 nits',
    screenSize: 16,
    colors: ['Carbon Black', 'Platinum Silver'],
  },
  {
    id: 'xps-13',
    name: 'XPS 13 Laptop',
    family: 'XPS',
    badge: 'PREMIUM PERFORMANCE',
    tagline: 'Iconic design. Incredible possibilities.',
    image: '/assets/xps13.png',
    priceCents: 119999,
    listPriceCents: 139999,
    rating: 4.4,
    reviews: 1096,
    processor: 'Intel\u00ae Core\u2122 Ultra 7 258V',
    graphics: 'Intel\u00ae Arc\u2122 Graphics',
    display: '13.4-inch, FHD+, 120Hz, 500 nits',
    screenSize: 13,
    colors: ['Platinum Silver', 'Graphite'],
  },
];

const MEMORY_OPTIONS = [
  { label: '16 GB', value: 16, priceCents: 0 },
  { label: '32 GB', value: 32, priceCents: 15000 },
];

const STORAGE_OPTIONS = [
  { label: '512 GB SSD', value: 512, priceCents: 0 },
  { label: '1 TB SSD', value: 1024, priceCents: 10000 },
];

/** The always-signed-in fictional customer shown under My Account. */
const DEMO_ACCOUNT = Object.freeze({
  demo: true,
  profile: {
    firstName: 'Alex',
    fullName: 'Alex Morgan',
    email: 'alex.morgan@example.com',
    accountNumber: 'DEMO-2026-014',
    organization: 'Northstar Design Studio',
  },
  rewards: { points: 4200, valueCents: 4200, membership: 'Dell Rewards member' },
  orders: [
    {
      id: 'DEMO-10482',
      productId: 'dell-14-plus',
      productName: 'Dell 14 Plus Laptop',
      image: '/assets/dell14.png',
      configuration: '32 GB memory \u00b7 1 TB SSD \u00b7 Ice Blue',
      quantity: 1,
      totalCents: 107999,
      orderedAt: 'November 4, 2026',
      expectedAt: 'November 14, 2026',
      status: 'In Production',
      step: 2,
      shipping: 'Standard delivery \u00b7 Sample office address',
      events: [
        { label: 'Order received', date: 'November 4, 2026', detail: 'Your demo order has been received.' },
        { label: 'Order confirmed', date: 'November 4, 2026', detail: 'Configuration confirmed for assembly.' },
        { label: 'In production', date: 'November 6, 2026', detail: 'Your laptop is being prepared.' },
      ],
    },
    {
      id: 'DEMO-10463',
      productId: 'xps-13',
      productName: 'XPS 13 Laptop',
      image: '/assets/xps13.png',
      configuration: '16 GB memory \u00b7 512 GB SSD \u00b7 Platinum Silver',
      quantity: 1,
      totalCents: 129599,
      orderedAt: 'October 22, 2026',
      expectedAt: 'October 29, 2026',
      status: 'Delivered',
      step: 4,
      shipping: 'Standard delivery \u00b7 Sample office address',
      events: [
        { label: 'Order received', date: 'October 22, 2026', detail: 'Your demo order has been received.' },
        { label: 'Shipped', date: 'October 26, 2026', detail: 'Your laptop left the fulfillment center.' },
        { label: 'Delivered', date: 'October 29, 2026', detail: 'Demo delivery complete. No real shipment.' },
      ],
    },
  ],
  devices: [
    { name: 'XPS 13 Laptop', image: '/assets/xps13.png', tag: 'DEMO-X13', coverage: 'Premium Support', expires: 'October 29, 2027' },
    { name: 'Dell 15 Laptop', image: '/assets/dell15.png', tag: 'DEMO-D15', coverage: 'Basic Hardware Service', expires: 'February 18, 2027' },
  ],
  savedProductIds: ['dell-16', 'xps-13'],
  subscriptions: [
    { name: 'Microsoft 365 Personal', status: 'Active', renewal: 'October 29, 2027', detail: 'Annual subscription \u00b7 1 user \u00b7 Sample entitlement' },
    { name: 'SupportAssist', status: 'Included', renewal: 'Included with your device', detail: 'Diagnostics and support \u00b7 No software is downloaded in this demo' },
  ],
});

module.exports = { PRODUCTS, MEMORY_OPTIONS, STORAGE_OPTIONS, DEMO_ACCOUNT };
