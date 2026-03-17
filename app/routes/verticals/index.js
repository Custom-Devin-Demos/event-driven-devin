const express = require('express');
const path = require('path');

const router = express.Router();

// Import all vertical route handlers
const bankingRoutes = require('./banking');
const financialServicesRoutes = require('./financial-services');
const insuranceRoutes = require('./insurance');
const cpgRoutes = require('./cpg');
const hightechRoutes = require('./hightech');
const industrialsRoutes = require('./industrials');
const healthcareRoutes = require('./healthcare');
const telcoRoutes = require('./telco');

// Mount API routes for each vertical
router.use(bankingRoutes);
router.use(financialServicesRoutes);
router.use(insuranceRoutes);
router.use(cpgRoutes);
router.use(hightechRoutes);
router.use(industrialsRoutes);
router.use(healthcareRoutes);
router.use(telcoRoutes);

/**
 * Vertical metadata for the landing page and URL routing
 */
const VERTICALS = [
  { id: 'retail', name: 'Retail eCommerce', brand: 'ACME Commerce', path: '/retail', icon: '\u{1F6D2}', color: '#c8a97e' },
  { id: 'banking', name: 'Banking', brand: 'Apex Bank', path: '/banking', icon: '\u{1F3E6}', color: '#2E86AB' },
  { id: 'financial-services', name: 'Financial Services', brand: 'Meridian Capital', path: '/financial-services', icon: '\u{1F4C8}', color: '#1B998B' },
  { id: 'insurance', name: 'Insurance', brand: 'Shield Insurance', path: '/insurance', icon: '\u{1F6E1}', color: '#E84855' },
  { id: 'cpg', name: 'CPG', brand: 'Harvest Goods', path: '/cpg', icon: '\u{1F4E6}', color: '#F18F01' },
  { id: 'hightech', name: 'High Tech', brand: 'NovaSoft', path: '/hightech', icon: '\u{1F4BB}', color: '#7B2CBF' },
  { id: 'industrials', name: 'Industrials', brand: 'Titan Manufacturing', path: '/industrials', icon: '\u{1F3ED}', color: '#6C757D' },
  { id: 'healthcare', name: 'Health Care', brand: 'CarePoint Health', path: '/healthcare', icon: '\u{1F3E5}', color: '#06D6A0' },
  { id: 'telco', name: 'Telco', brand: 'WaveConnect', path: '/telco', icon: '\u{1F4F1}', color: '#118AB2' },
];

/**
 * GET /api/verticals — returns all available verticals
 */
router.get('/api/verticals', (_req, res) => {
  res.json({ verticals: VERTICALS });
});

/**
 * Serve vertical-specific HTML pages
 * Each vertical gets its own clean URL: /banking, /insurance, /telco, etc.
 */
const verticalIds = ['banking', 'financial-services', 'insurance', 'cpg', 'hightech', 'industrials', 'healthcare', 'telco'];
for (const id of verticalIds) {
  router.get(`/${id}`, (_req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', `${id}.html`));
  });
}

// Retail uses the existing index.html at /retail
router.get('/retail', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'index.html'));
});

// Landing page hub — shows all verticals with easy-to-reach URLs
router.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'hub.html'));
});

module.exports = router;
module.exports.VERTICALS = VERTICALS;
