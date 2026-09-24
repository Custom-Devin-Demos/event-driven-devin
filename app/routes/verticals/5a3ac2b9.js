const express = require('express');
const { generateBoard, PROJECTS, FRAME_FORMATS, LOOKS } = require('../../services/verticals/5a3ac2b9');

const router = express.Router();

// Reproduction mode lets a remediation session fail the request on camera without
// re-raising the incident it was created from. Ignored in production.
function isReproductionRequest(req) {
  return Boolean(req.headers['x-synthetic']) && process.env.NODE_ENV !== 'production';
}

router.get('/api/5a3ac2b9/projects', (_req, res) => {
  res.json({ projects: Object.values(PROJECTS) });
});

router.get('/api/5a3ac2b9/options', (_req, res) => {
  res.json({
    frameFormats: Object.values(FRAME_FORMATS).map(({ id, label, aspect }) => ({ id, label, aspect })),
    looks: Object.values(LOOKS).map(({ id, label }) => ({ id, label })),
  });
});

router.post('/api/5a3ac2b9/previs', async (req, res) => {
  const body = req.body || {};

  try {
    const result = await generateBoard({
      projectId: body.projectId || 'onslaught',
      sceneText: body.sceneText,
      frameFormat: body.frameFormat || 'anamorphic-239',
      lookId: body.lookId || 'vision3-500t',
      shotCount: body.shotCount,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
      synthetic: isReproductionRequest(req),
    });
    res.json(result);
  } catch (error) {
    if (error.statusCode === 400 || error.name === 'PrevisError') {
      return res.status(400).json({
        success: false,
        error: error.message,
        errorClass: error.name,
        code: error.code || 'INVALID_PREVIS_REQUEST',
        requestId: error.requestId || req.requestId,
      });
    }

    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: 'PREVIS_RENDER_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;
