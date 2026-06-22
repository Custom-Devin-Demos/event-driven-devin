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
const customer304db83fRoutes = require('./304db83f');
const customer1a459b91Routes = require('./1a459b91');
const customerBeb4d43eRoutes = require('./beb4d43e');
const customer4feeb7bbRoutes = require('./4feeb7bb');
const customer89c1f355Routes = require('./89c1f355');
const customer99a8ba1aRoutes = require('./99a8ba1a');
const customerB3e22436Routes = require('./b3e22436');
const customerD5fc3172Routes = require('./d5fc3172');
const customerA30498aeRoutes = require('./a30498ae');
const customer766718e2Routes = require('./766718e2');
const customerC4a8e2b7Routes = require('./c4a8e2b7');
const customer7d2e9f4aRoutes = require('./7d2e9f4a');
const customerC65e3d81Routes = require('./c65e3d81');
const marsRoutes = require('./mars');
const lillyRoutes = require('./lilly');
const levisRoutes = require('./levis');
const threatlyRoutes = require('./threatly');
const customerB3587482Routes = require('./b3587482');
const customerBbvaRoutes = require('./bbva');
const bestbuyRoutes = require('./bestbuy');
const syscoRoutes = require('./sysco');
const vfcRoutes = require('./vfc');
const customer841afdc1Routes = require('./841afdc1');
const customer17dd6f6fRoutes = require('./17dd6f6f');

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
router.use(customer304db83fRoutes);
router.use(customer1a459b91Routes);
router.use(customerBeb4d43eRoutes);
router.use(customer4feeb7bbRoutes);
router.use(customer89c1f355Routes);
router.use(customer99a8ba1aRoutes);
router.use(customerB3e22436Routes);
router.use(customerD5fc3172Routes);
router.use(customerA30498aeRoutes);
router.use(customer766718e2Routes);
router.use(customerC4a8e2b7Routes);
router.use(customer7d2e9f4aRoutes);
router.use(customerC65e3d81Routes);
router.use(marsRoutes);
router.use(lillyRoutes);
router.use(levisRoutes);
router.use(threatlyRoutes);
router.use(customerB3587482Routes);
router.use(customerBbvaRoutes);
router.use(bestbuyRoutes);
router.use(syscoRoutes);
router.use(vfcRoutes);
router.use(customer841afdc1Routes);
router.use(customer17dd6f6fRoutes);

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
  { id: 'c65e3d81', name: 'Health Insurance', brand: 'CVS Health', path: '/c65e3d81', icon: '\u{2764}\u{FE0F}', color: '#CC0000' },
  { id: 'mars', name: 'Supply Chain', brand: 'Mars, Inc.', path: '/mars', icon: '\u{1F4E6}', color: '#002855' },
  { id: 'lilly', name: 'Pharma Supply Chain', brand: 'Eli Lilly', path: '/lilly', icon: '\u{1F48A}', color: '#E1241B' },
  { id: 'levis', name: 'Apparel eCommerce', brand: "Levi's", path: '/levis', icon: '\u{1F456}', color: '#c41230' },
  { id: 'threatly', name: 'Security Automation', brand: 'Threatly', path: '/threatly', icon: '\u{26A1}', color: '#7c3aed' },
  { id: 'b3587482', name: 'Catering', brand: 'Chick-fil-A', path: '/b3587482', icon: '\u{1F414}', color: '#E51636' },
  { id: 'bestbuy', name: 'Retail Supply Chain', brand: 'Best Buy', path: '/bestbuy', icon: '\u{1F3F7}\u{FE0F}', color: '#0046BE' },
  { id: 'sysco', name: 'Foodservice Supply Chain', brand: 'Sysco', path: '/sysco', icon: '\u{1F371}', color: '#0071CE' },
  { id: 'vfc', name: 'Outdoor & Apparel eCommerce', brand: 'VF Corporation', path: '/vfc', icon: '\u{1F9E5}', color: '#13294b' },

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
const verticalIds = ['banking', 'financial-services', 'insurance', 'cpg', 'hightech', 'industrials', 'healthcare', 'telco', 'a6b38c63', 'ef5d1dc1', '13ec88e4', '8de4a567', '1845924d', 'e0c16510', '53a9884e', 'acf4303d', 'f3ff1d33', '430a4200', 'b62fa21d', 'f2f54159', '304db83f', '1a459b91', 'beb4d43e', '4feeb7bb', '89c1f355', '99a8ba1a', 'b3e22436', 'd5fc3172', 'a30498ae', '766718e2', 'c4a8e2b7', '7d2e9f4a', 'c65e3d81', 'mars', 'lilly', 'levis', 'threatly', 'b3587482', 'bbva', 'bestbuy', 'sysco', 'vfc', '841afdc1', '17dd6f6f'];
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
