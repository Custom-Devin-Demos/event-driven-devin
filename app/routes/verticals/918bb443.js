const express = require('express');
const { processTemplateUpload, TEMPLATE_LIBRARY, STAGED_TEMPLATE } = require('../../services/verticals/918bb443');

const router = express.Router();

function toFieldKey(header) {
  return String(header)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function extractHeaderRow(upload) {
  const columns = (upload.sheet && upload.sheet.columns) || [];
  return columns.map((col) => toFieldKey(col.header));
}

/**
 * GET /api/918bb443/workspace — staged client upload plus the template library
 */
router.get('/api/918bb443/workspace', (_req, res) => {
  res.json({
    staged: STAGED_TEMPLATE,
    library: TEMPLATE_LIBRARY.map((tpl) => ({
      templateId: tpl.templateId,
      name: tpl.name,
      revision: tpl.revision,
      practice: tpl.practice,
      owner: tpl.owner,
      columnCount: tpl.columns.length,
    })),
  });
});

/**
 * POST /api/918bb443/templates/upload — identify, map and validate a staged upload
 */
router.post('/api/918bb443/templates/upload', async (req, res) => {
  const upload = STAGED_TEMPLATE.uploadId === req.body.uploadId || !req.body.uploadId
    ? STAGED_TEMPLATE
    : null;

  if (!upload) {
    return res.status(404).json({ success: false, error: 'Upload not found', code: 'UPLOAD_NOT_FOUND' });
  }

  try {
    const result = await processTemplateUpload({
      upload,
      headers: extractHeaderRow(upload),
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
      requestId: req.requestId,
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: 'TEMPLATE_UPLOAD_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
