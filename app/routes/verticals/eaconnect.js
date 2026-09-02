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
  try {
    const result = await sendPartyInvite({
      accountId: req.body.account_id || req.body.accountId,
      friendId: req.body.friend_id || req.body.friendId,
      game: req.body.game,
      client: req.get('X-EAConnect-Client'),
      demoToken: req.get('X-EAConnect-Demo-Token'),
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
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
