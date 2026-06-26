const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Productos (cuentas) del cliente para la demo de Scotiabank Chile.
 * Montos en pesos chilenos (CLP).
 */
const PRODUCTOS = [
  { id: 'CTA-CTE-0042', name: 'Cuenta Corriente Scotiabank', type: 'corriente', balance: 4385200, currency: 'CLP' },
  { id: 'CTA-VIS-0188', name: 'Cuenta Vista', type: 'vista', balance: 1290450, currency: 'CLP' },
  { id: 'CTA-AHO-0319', name: 'Cuenta de Ahorro', type: 'ahorro', balance: 8740000, currency: 'CLP' },
  { id: 'TC-VISA-7741', name: 'Tarjeta de Crédito Visa Signature', type: 'credito', balance: -612300, currency: 'CLP' },
];

/**
 * Destinatarios frecuentes (transferencias a terceros).
 */
const DESTINATARIOS = [
  { id: 'DEST-1001', name: 'María José Fuentes', rut: '15.482.330-1', banco: 'Scotiabank Chile', cuenta: 'CTA-CTE-9920', tipo: 'misma-institucion' },
  { id: 'DEST-1002', name: 'Cristóbal Reyes', rut: '17.903.221-K', banco: 'Banco de Chile', cuenta: 'CTA-CTE-4471', tipo: 'interbancaria' },
  { id: 'DEST-1003', name: 'Antonia Vergara', rut: '19.220.118-4', banco: 'BancoEstado', cuenta: 'CTA-RUT-3380', tipo: 'interbancaria' },
  { id: 'DEST-1004', name: 'Sebastián Muñoz', rut: '13.557.804-2', banco: 'Scotiabank Chile', cuenta: 'CTA-VIS-2261', tipo: 'misma-institucion' },
];

/**
 * Movimientos recientes para mostrar en el dashboard.
 */
const MOVIMIENTOS = [
  { id: 'MOV-001', date: '2026-06-22', description: 'Abono de Sueldo - Empleador', amount: 1850000, type: 'credit', account: 'CTA-CTE-0042' },
  { id: 'MOV-002', date: '2026-06-21', description: 'Transferencia a María José Fuentes', amount: -120000, type: 'debit', account: 'CTA-CTE-0042' },
  { id: 'MOV-003', date: '2026-06-20', description: 'Compra Jumbo Costanera Center', amount: -84990, type: 'debit', account: 'CTA-CTE-0042' },
  { id: 'MOV-004', date: '2026-06-19', description: 'Pago Cuenta de Luz - Enel', amount: -45320, type: 'debit', account: 'CTA-CTE-0042' },
  { id: 'MOV-005', date: '2026-06-18', description: 'Devolución SII - Renta', amount: 238000, type: 'credit', account: 'CTA-CTE-0042' },
];

/**
 * Esquema de comisiones por plan de cuenta.
 * NOTA: El "Plan Premium" tiene feeSchedule en null de forma intencional
 * porque incluye transferencias ilimitadas sin costo — el cálculo de
 * comisión debería cortocircuitar antes de leer propiedades del esquema.
 * Sin embargo, calcularComision lee .comisionInterbancaria sin validar.
 */
const PLANES = {
  premium: { cargoMensual: 0, feeSchedule: null },
  clasico: { cargoMensual: 5990, feeSchedule: { comisionInterbancaria: 350, comisionMismaInstitucion: 0, topeDiario: 5000000 } },
  basico:  { cargoMensual: 2990, feeSchedule: { comisionInterbancaria: 500, comisionMismaInstitucion: 0, topeDiario: 2000000 } },
};

/**
 * Resuelve el plan de cuenta del cliente.
 */
function resolverPlan(plan) {
  const config = PLANES[plan];
  if (!config) return null;
  return { config };
}

/**
 * Calcula la comisión de la transferencia según el plan y el tipo.
 * BUG: En el "Plan Premium" feeSchedule es null porque las transferencias
 * son gratuitas. Acceder a .comisionInterbancaria sobre null lanza TypeError.
 */
function calcularComision(planData, tipoTransferencia) {
  const tarifa = tipoTransferencia === 'interbancaria'
    ? planData.config.feeSchedule.comisionInterbancaria
    : planData.config.feeSchedule.comisionMismaInstitucion;
  return tarifa > 0 ? tarifa : 0;
}

/**
 * Construye el comprobante de la transferencia.
 */
function construirComprobante(transferencia, comision) {
  const totalDebito = transferencia.amount + comision;
  return {
    comprobanteId: `SCL-${Date.now()}`,
    origen: transferencia.fromAccount,
    destinatario: transferencia.destinatarioNombre,
    rut: transferencia.rut,
    bancoDestino: transferencia.bancoDestino,
    monto: transferencia.amount,
    comision,
    totalDebito,
    tipo: transferencia.tipoTransferencia,
    comentario: transferencia.comentario || '',
    timestamp: new Date().toISOString(),
    metodo: 'Transferencia a Terceros',
  };
}

/**
 * Procesa una transferencia a terceros.
 */
async function procesarTransferencia(data) {
  const startTime = Date.now();
  const transferId = uuidv4();

  logger.info('Procesando transferencia a terceros', {
    transferId,
    fromAccount: data.fromAccount,
    destinatario: data.destinatarioNombre,
    amount: data.amount,
    tipo: data.tipoTransferencia,
    service: 'scotiabank-cl-transferencias',
    route: '/api/scotiabankchile/transferencia',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const planData = resolverPlan(data.plan);
    const comision = calcularComision(planData, data.tipoTransferencia);
    const comprobante = construirComprobante(data, comision);

    const duration = Date.now() - startTime;

    incrementMetric('transferencia.success', {
      route: '/api/scotiabankchile/transferencia',
      tipo: data.tipoTransferencia,
    });
    recordTiming('transferencia.latency', duration, {
      route: '/api/scotiabankchile/transferencia',
    });

    return {
      success: true,
      transferId,
      comprobante,
      status: 'enviada',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('transferencia.failure', {
      route: '/api/scotiabankchile/transferencia',
      errorClass: error.name,
      tipo: data.tipoTransferencia,
    });
    recordTiming('transferencia.latency', duration, {
      route: '/api/scotiabankchile/transferencia',
      error: 'true',
    });

    logger.error('Transferencia a terceros fallida', {
      transferId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      fromAccount: data.fromAccount,
      destinatario: data.destinatarioNombre,
      service: 'scotiabank-cl-transferencias',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/scotiabankchile/transferencia',
        service: 'scotiabank-cl-transferencias',
        tipo: data.tipoTransferencia,
      },
      extra: {
        transferId,
        fromAccount: data.fromAccount,
        destinatario: data.destinatarioNombre,
        amount: data.amount,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/scotiabankchile.js \u2014 calcularComision',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'scotiabank-cl-transferencias',
      verticalLabel: 'Scotiabank Chile Transferencias',
      customer: 'scotiabankchile',
      tags: [
        { key: 'route', value: '/api/scotiabankchile/transferencia' },
        { key: 'service', value: 'scotiabank-cl-transferencias' },
        { key: 'tipo', value: data.tipoTransferencia },
      ],
      extra: { transferId, fromAccount: data.fromAccount, destinatario: data.destinatarioNombre, amount: data.amount },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'scotiabank-cl-transferencias@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from transferencia error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { procesarTransferencia, PRODUCTOS, DESTINATARIOS, MOVIMIENTOS, PLANES };
