const express = require('express');
const {
  updateRiotId,
  ACCOUNTS,
  SHARDS,
  POLICY_REJECTION_CODES,
} = require('../../services/verticals/6f38d771');

const router = express.Router();

router.get('/api/6f38d771/accounts', (_req, res) => {
  res.json({
    accounts: Object.entries(ACCOUNTS).map(([username, a]) => ({
      username,
      puuid: a.puuid,
      gameName: a.gameName,
      tagLine: a.tagLine,
      region: a.region,
      locale: a.locale,
      accountLevel: a.accountLevel,
      statusMessage: a.statusMessage,
      games: a.games,
    })),
    shards: Object.values(SHARDS),
  });
});

router.post('/api/6f38d771/riot-id', async (req, res) => {
  const body = req.body || {};
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const gameName = typeof body.gameName === 'string' ? body.gameName.trim() : '';
  const tagLine = typeof body.tagLine === 'string' ? body.tagLine.trim().replace(/^#/, '') : '';

  if (!Object.hasOwn(ACCOUNTS, username)) {
    return res.status(401).json({ success: false, error: 'INVALID_TOKEN: session is not bound to a known account', code: 'INVALID_TOKEN' });
  }
  if (!gameName || !tagLine) {
    return res.status(400).json({ success: false, error: 'game name and tagline are required', code: 'VALIDATION_ERROR' });
  }

  try {
    const result = await updateRiotId({
      username,
      gameName,
      tagLine,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    return res.json(result);
  } catch (error) {
    const status = POLICY_REJECTION_CODES.has(error.code) ? 400 : 500;
    return res.status(status).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'RIOT_ID_UPDATE_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
