const express = require('express');
const { procesarTransferencia, PRODUCTOS, DESTINATARIOS, MOVIMIENTOS } = require('../../services/verticals/scotiabankchile');

const router = express.Router();

/**
 * GET /api/scotiabankchile/cuentas — retorna productos, destinatarios y movimientos
 */
router.get('/api/scotiabankchile/cuentas', (_req, res) => {
  res.json({ productos: PRODUCTOS, destinatarios: DESTINATARIOS, movimientos: MOVIMIENTOS });
});

/**
 * POST /api/scotiabankchile/transferencia — procesa una transferencia a terceros
 */
router.post('/api/scotiabankchile/transferencia', async (req, res) => {
  try {
    const result = await procesarTransferencia({
      fromAccount: req.body.fromAccount || 'CTA-CTE-0042',
      destinatarioId: req.body.destinatarioId || 'DEST-1002',
      destinatarioNombre: req.body.destinatarioNombre || 'Cristóbal Reyes',
      rut: req.body.rut || '17.903.221-K',
      bancoDestino: req.body.bancoDestino || 'Banco de Chile',
      amount: req.body.amount || 120000,
      tipoTransferencia: req.body.tipoTransferencia || 'interbancaria',
      plan: req.body.plan || 'premium',
      comentario: req.body.comentario || '',
      userId: req.body.userId || 'usr_scotiabankchile_1',
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    const statusCode = error.code === 'INSUFFICIENT_FUNDS' ? 422 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'TRANSFERENCIA_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
