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
const customer20cd1314Routes = require('./20cd1314');
const customer8096ad15Routes = require('./8096ad15');
const customer46d4846dRoutes = require('./46d4846d');
const customerCba5be2dRoutes = require('./cba5be2d');
const customer696ecb91Routes = require('./696ecb91');
const customer74124a39Routes = require('./74124a39');
const customer91fe5a5fRoutes = require('./91fe5a5f');
const customerEb2f4ad1Routes = require('./eb2f4ad1');
const customerA131fea3Routes = require('./a131fea3');
const customer3a224949Routes = require('./3a224949');
const customerB3587482Routes = require('./b3587482');
const customer4886afe1Routes = require('./4886afe1');
const customer6074332dRoutes = require('./6074332d');
const customerEb3df102Routes = require('./eb3df102');
const customerF9296fb3Routes = require('./f9296fb3');
const customer3699f348Routes = require('./3699f348');
const customer8491be2cRoutes = require('./8491be2c');
const customer841afdc1Routes = require('./841afdc1');
const customer6f543fa2Routes = require('./6f543fa2');
const customerF91c0df3Routes = require('./f91c0df3');
const customer058419acRoutes = require('./058419ac');
const customerF5a355e7Routes = require('./f5a355e7');
const customerB683fdf3Routes = require('./b683fdf3');
const customer0141c475Routes = require('./0141c475');
const customer8d933e67Routes = require('./8d933e67');
const customerAc1752e4Routes = require('./ac1752e4');
const customer17dd6f6fRoutes = require('./17dd6f6f');
const customer08381313Routes = require('./08381313');
const customerDf3f450cRoutes = require('./df3f450c');
const customerE433d32dRoutes = require('./e433d32d');
const customer16ebec74Routes = require('./16ebec74');
const customer4ada28b9Routes = require('./4ada28b9');
const customerA8585092Routes = require('./a8585092');
const customerAd960e6aRoutes = require('./ad960e6a');
const customer054f8313Routes = require('./054f8313');
const customer91e30701Routes = require('./91e30701');
const customerC35ea2e0Routes = require('./c35ea2e0');
const customer382b34fcRoutes = require('./382b34fc');
const customer8b5893cbRoutes = require('./8b5893cb');
const customer12b28f14Routes = require('./12b28f14');
const customer220cee45Routes = require('./220cee45');
const customer43f2f084Routes = require('./43f2f084');

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
router.use(customer20cd1314Routes);
router.use(customer8096ad15Routes);
router.use(customer46d4846dRoutes);
router.use(customerCba5be2dRoutes);
router.use(customer696ecb91Routes);
router.use(customer74124a39Routes);
router.use(customer91fe5a5fRoutes);
router.use(customerEb2f4ad1Routes);
router.use(customerA131fea3Routes);
router.use(customer3a224949Routes);
router.use(customerB3587482Routes);
router.use(customer4886afe1Routes);
router.use(customer6074332dRoutes);
router.use(customerEb3df102Routes);
router.use(customerF9296fb3Routes);
router.use(customer3699f348Routes);
router.use(customer8491be2cRoutes);
router.use(customer841afdc1Routes);
router.use(customer6f543fa2Routes);
router.use(customerF91c0df3Routes);
router.use(customer058419acRoutes);
router.use(customerF5a355e7Routes);
router.use(customerB683fdf3Routes);
router.use(customer0141c475Routes);
router.use(customer8d933e67Routes);
router.use(customerAc1752e4Routes);
router.use(customer17dd6f6fRoutes);
router.use(customer08381313Routes);
router.use(customerDf3f450cRoutes);
router.use(customerE433d32dRoutes);
router.use(customer16ebec74Routes);
router.use(customer4ada28b9Routes);
router.use(customerA8585092Routes);
router.use(customerAd960e6aRoutes);
router.use(customer054f8313Routes);
router.use(customer91e30701Routes);
router.use(customerC35ea2e0Routes);
router.use(customer382b34fcRoutes);
router.use(customer8b5893cbRoutes);
router.use(customer12b28f14Routes);
router.use(customer220cee45Routes);
router.use(customer43f2f084Routes);

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
const verticalIds = ['8b5893cb', 'banking', 'financial-services', 'insurance', 'cpg', 'hightech', 'industrials', 'healthcare', 'telco', 'a6b38c63', 'ef5d1dc1', '13ec88e4', '8de4a567', '1845924d', 'e0c16510', '53a9884e', 'acf4303d', 'f3ff1d33', '430a4200', 'b62fa21d', 'f2f54159', '304db83f', '1a459b91', 'beb4d43e', '4feeb7bb', '89c1f355', '99a8ba1a', 'b3e22436', 'd5fc3172', 'a30498ae', '766718e2', 'c4a8e2b7', '7d2e9f4a', 'c65e3d81', '20cd1314', '8096ad15', '46d4846d', 'cba5be2d', '696ecb91', 'eb2f4ad1', 'a131fea3', '3a224949', 'b3587482', '4886afe1', '6074332d', 'eb3df102', 'f9296fb3', '3699f348', '8491be2c', '841afdc1', '74124a39', '91fe5a5f', '6f543fa2', 'f91c0df3', '058419ac', 'f5a355e7', 'b683fdf3', '0141c475', '8d933e67', 'ac1752e4', '17dd6f6f', '08381313', 'df3f450c', 'e433d32d', '16ebec74', '4ada28b9', 'a8585092', 'ad960e6a', '054f8313', '91e30701', 'c35ea2e0', '382b34fc', '12b28f14', '220cee45', '43f2f084'];
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
