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
const customerA6b38c63Routes = require('./a6b38c63');
const customerEf5d1dc1Routes = require('./ef5d1dc1');
const customer13ec88e4Routes = require('./13ec88e4');
const customer8de4a567Routes = require('./8de4a567');
const customer1845924dRoutes = require('./1845924d');
const customerE0c16510Routes = require('./e0c16510');
const customer53a9884eRoutes = require('./53a9884e');
const customerAcf4303dRoutes = require('./acf4303d');
const customerF3ff1d33Routes = require('./f3ff1d33');
const customer430a4200Routes = require('./430a4200');
const customerB62fa21dRoutes = require('./b62fa21d');
const customerF2f54159Routes = require('./f2f54159');
const customer4feeb7bbRoutes = require('./4feeb7bb');

// Mount API routes for each vertical
router.use(bankingRoutes);
router.use(financialServicesRoutes);
router.use(insuranceRoutes);
router.use(cpgRoutes);
router.use(hightechRoutes);
router.use(industrialsRoutes);
router.use(healthcareRoutes);
router.use(telcoRoutes);
router.use(customerA6b38c63Routes);
router.use(customerEf5d1dc1Routes);
router.use(customer13ec88e4Routes);
router.use(customer8de4a567Routes);
router.use(customer1845924dRoutes);
router.use(customerE0c16510Routes);
router.use(customer53a9884eRoutes);
router.use(customerAcf4303dRoutes);
router.use(customerF3ff1d33Routes);
router.use(customer430a4200Routes);
router.use(customerB62fa21dRoutes);
router.use(customerF2f54159Routes);
router.use(customer4feeb7bbRoutes);

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
  { id: '8de4a567', name: 'Financial Technology', brand: 'FinScore', path: '/8de4a567', icon: '\u{1F4B3}', color: '#008751' },
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
const verticalIds = ['banking', 'financial-services', 'insurance', 'cpg', 'hightech', 'industrials', 'healthcare', 'telco', 'a6b38c63', 'ef5d1dc1', '13ec88e4', '8de4a567', '1845924d', 'e0c16510', '53a9884e', 'acf4303d', 'f3ff1d33', '430a4200', 'b62fa21d', 'f2f54159', '4feeb7bb'];
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
