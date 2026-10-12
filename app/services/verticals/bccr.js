const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const PUBLICACIONES = require('./bccr-publicaciones.json');

const SERVICE = 'bccr-publicaciones-sector-real';
const ROUTE = '/api/bccr/descargas';
const PAGE = '/bccr';

const REMEDIATION_DIRECTIVE = [
  '*Repositorio a investigar y corregir:* `COG-GTM/event-driven-devin`',
  '',
  'La ruta que falla es la descarga de publicaciones de Sector Real del BCCR:',
  '- Servicio: `app/services/verticals/bccr.js`',
  '- Catálogo: `app/services/verticals/bccr-publicaciones.json`',
  '- Ruta: `app/routes/verticals/bccr.js`',
  `- Página: \`app/public/verticals/bccr.html\` (servida en \`${PAGE}\`)`,
  '',
  'Empieza por la publicación cuya descarga falló y revisa cómo se resuelve su',
  'tema contra el catálogo de temas — el punto del crash está aguas abajo de una',
  'migración de la taxonomía de temas, no es la causa.',
  '',
  'Abre un pull request contra `main` con la corrección y verifícala de punta a',
  `punta en la página \`${PAGE}\`.`,
].join('\n');

const TEMAS = {
  'pib-sector-externo': { label: 'PIB y sector externo', carpeta: 'pib-sector-externo' },
  'cuentas-nacionales': { label: 'Cuentas nacionales', carpeta: 'cuentas-nacionales' },
  'actividad-economica': { label: 'Actividad económica', carpeta: 'actividad-economica' },
  'matriz-insumo-producto': { label: 'Matriz insumo producto', carpeta: 'matriz-insumo-producto' },
  'acceso-financiero': { label: 'Acceso a servicios financieros', carpeta: 'acceso-financiero' },
};

const FORMATOS = {
  pdf: 'PDF',
  xlsx: 'Excel',
  docx: 'Word',
};

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

function listPublicaciones() {
  return {
    seccion: 'Sector Real',
    temas: Object.entries(TEMAS).map(([id, tema]) => ({ id, label: tema.label })),
    publicaciones: PUBLICACIONES.map(({
      id, titulo, fecha, tema, formato,
    }) => ({
      id, titulo, fecha, tema, formato: FORMATOS[formato] || formato.toUpperCase(),
    })),
  };
}

function buildDocumentDelivery(publicacion) {
  const tema = TEMAS[publicacion.tema];
  return {
    url: publicacion.link,
    archivo: `${tema.carpeta}/${publicacion.id}.${publicacion.formato}`,
    tema: tema.label,
    formato: FORMATOS[publicacion.formato] || publicacion.formato.toUpperCase(),
  };
}

async function descargarPublicacion(data = {}) {
  const startTime = Date.now();
  const descargaId = `DESC-${uuidv4().slice(0, 8).toUpperCase()}`;
  const publicacion = PUBLICACIONES.find((p) => p.id === data.publicacionId);

  if (!publicacion) {
    incrementMetric('bccr_descarga.rejected', { route: ROUTE });
    throw new ValidationError('La publicación solicitada no existe.');
  }

  logger.info('Preparando descarga de publicación BCCR', {
    descargaId,
    publicacionId: publicacion.id,
    tema: publicacion.tema,
    service: SERVICE,
  });

  try {
    const entrega = buildDocumentDelivery(publicacion);
    const duration = Date.now() - startTime;

    incrementMetric('bccr_descarga.success', { route: ROUTE, tema: publicacion.tema });
    recordTiming('bccr_descarga.latency', duration, { route: ROUTE });

    return {
      success: true,
      descargaId,
      publicacionId: publicacion.id,
      titulo: publicacion.titulo,
      ...entrega,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('bccr_descarga.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('bccr_descarga.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Falló la descarga de publicación BCCR', {
      descargaId,
      publicacionId: publicacion.id,
      tema: publicacion.tema,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE, service: SERVICE, page: PAGE, alert_path: 'instant',
      },
      extra: {
        descargaId,
        publicacionId: publicacion.id,
        titulo: publicacion.titulo,
        tema: publicacion.tema,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/bccr.js — descargarPublicacion',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'BCCR — Descarga de publicaciones Sector Real',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 'bccr',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'page', value: PAGE },
        { key: 'publicacion', value: publicacion.id },
        { key: 'tema', value: publicacion.tema },
      ],
      extra: {
        descargaId, publicacionId: publicacion.id, titulo: publicacion.titulo, tema: publicacion.tema,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@1.0.0`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to trigger Devin session from BCCR download error', {
        descargaId,
        error: alertError.message,
      });
    });

    error.descargaId = descargaId;
    throw error;
  }
}

module.exports = {
  descargarPublicacion,
  listPublicaciones,
  PUBLICACIONES,
  TEMAS,
  ValidationError,
};
