const express = require('express');
const { login } = require('../services/auth');

const router = express.Router();

router.post('/login', async (req, res) => {
  try {
    const { username, password, persona } = req.body;
    const result = await login(
      username || 'demo@acme.com',
      password || 'demo',
      persona || 'buyer_1'
    );
    res.json(result);
  } catch (error) {
    res.status(401).json({
      success: false,
      error: error.message,
    });
  }
});

module.exports = router;
