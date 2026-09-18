const express = require('express');
const path = require('path');

const router = express.Router();
const PUBLIC = path.join(__dirname, '..', 'public', 'lifeco');

const BRANDS = ['pcc', 'lifeco', 'canada-life', 'irish-life', 'empower', 'igm-financial', 'ig-wealth', 'mackenzie'];

router.get(['/lifeco', '/lifeco/'], (_req, res) => {
  res.sendFile(path.join(PUBLIC, 'index.html'));
});

router.get('/lifeco/:brand', (req, res, next) => {
  if (!BRANDS.includes(req.params.brand)) return next();
  res.sendFile(path.join(PUBLIC, 'brands', `${req.params.brand}.html`));
});

module.exports = router;
