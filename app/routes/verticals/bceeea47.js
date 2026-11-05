const express = require('express');
const logger = require('../../telemetry/logger');
const { dispatchRemoteCommand, resetGarage, getGarage } = require('../../services/verticals/bceeea47');

const router = express.Router();

/** GET /api/bceeea47/garage — the owner's vehicle, available remote commands, recent activity and service status. */
router.get('/api/bceeea47/garage', (_req, res) => {
  res.json(getGarage());
});

/** POST /api/bceeea47/remote-commands — send a remote command (lock, unlock, remote-start, locate) to the vehicle. */
router.post('/api/bceeea47/remote-commands', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await dispatchRemoteCommand({
      commandId: body.commandId,
      pin: body.pin,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    if (error.statusCode === 400) {
      return res.status(400).json({ success: false, error: error.message });
    }
    logger.error('Remote command request failed', { error: error.message, service: 'bceeea47-api' });
    res.status(500).json({
      success: false,
      error: error.message,
      errorType: error.name,
      status: getGarage().status,
    });
  }
});

/** POST /api/bceeea47/remote-commands/reset — presenter control: clear activity and return the garage to its opening state. */
router.post('/api/bceeea47/remote-commands/reset', (_req, res) => {
  const result = resetGarage();
  res.status(result.success ? 200 : 409).json(result);
});

module.exports = router;
