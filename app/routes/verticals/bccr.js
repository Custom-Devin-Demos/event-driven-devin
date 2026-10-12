const express = require('express');
const path = require('node:path');
const {
  descargarPublicacion,
  listPublicaciones,
  ValidationError,
} = require('../../services/verticals/bccr');

const router = express.Router();

router.get('/bccr', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', 'bccr.html'));
});

router.get('/api/bccr/publicaciones', (_req, res) => {
  res.json(listPublicaciones());
});

router.post('/api/bccr/descargas', async (req, res) => {
  const body = req.body || {};

  try {
    const result = await descargarPublicacion({
      publicacionId: body.publicacionId,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    if (error instanceof ValidationError) {
      return res.status(400).json({
        success: false,
        error: error.message,
        errorClass: 'ValidationError',
        code: 'PUBLICACION_INVALIDA',
      });
    }

    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: 'DESCARGA_FALLIDA',
      descargaId: error.descargaId || req.requestId,
    });
  }
});

module.exports = router;
