const express = require('express');
const { finalizeTranscript } = require('../../services/oncall-verticals/voice');

const router = express.Router();

/**
 * POST /api/voice/transcribe — finalize a dictated utterance
 *
 * The dictation console has no legacy service of its own; the un-shimmed page
 * delegates to the same finalization service the on-call endpoint uses, so
 * opening voice.html directly works instead of 404ing.
 */
router.post('/api/voice/transcribe', async (req, res) => {
  try {
    const result = await finalizeTranscript({
      workspace: req.body.workspace || 'Brightmail',
      dictionary: String(req.body.dictionary || 'general').toLowerCase(),
      utterance: String(req.body.utterance || '').slice(0, 4000),
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'TRANSCRIBE_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
