const express = require('express');
const { sendPartyInvite } = require('../../services/verticals/eaconnect');

const router = express.Router();

/**
 * POST /api/eaconnect/party/invite — invite a friend to a cross-platform party.
 *
 * Called by the EA Connect Android app (neil-z-kelly/eaconnect-android); there
 * is no web page for this vertical.
 */
router.post('/api/eaconnect/party/invite', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await sendPartyInvite({
      accountId: body.account_id || body.accountId,
      friendId: body.friend_id || body.friendId,
      game: body.game,
      client: req.get('X-EAConnect-Client'),
      demoToken: req.get('X-EAConnect-Demo-Token'),
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.name || 'Error',
      message: error.message,
      code: error.code || 'PARTY_INVITE_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
