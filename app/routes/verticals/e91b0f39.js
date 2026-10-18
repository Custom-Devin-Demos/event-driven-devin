const express = require('express');
const path = require('path');

const router = express.Router();
const pagePath = path.join(__dirname, '..', '..', 'public', 'verticals', 'e91b0f39', 'index.html');

router.get(['/e91b0f39', '/e91b0f39/'], (_req, res) => {
  res.set('Cache-Control', 'no-cache').sendFile(pagePath);
});

module.exports = router;
