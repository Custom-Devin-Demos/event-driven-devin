const express = require('express');
const path = require('path');
const {
  submitInquiry,
  reportPortalFailure,
  ENGINE_PROGRAMS,
} = require('../../services/verticals/5b992ae7');

const router = express.Router();

/**
 * GET /5b992ae7/app — Flutter web build of the GE Aerospace Customer Portal
 * (github.com/Custom-Devin-Demos/ge-customer-portal), copied into
 * app/public/verticals/5b992ae7-app/ by `flutter build web --base-href /5b992ae7/app/`.
 * The marketing page at /5b992ae7 is untouched; the portal is a separate product
 * surface that calls the same /api/5b992ae7 endpoints below.
 */
const PORTAL_WEB_DIR = path.join(__dirname, '..', '..', 'public', 'verticals', '5b992ae7-app');
router.use('/5b992ae7/app', express.static(PORTAL_WEB_DIR, { index: 'index.html' }));
router.get('/5b992ae7/app/{*splat}', (_req, res) => {
  res.sendFile(path.join(PORTAL_WEB_DIR, 'index.html'));
});

/**
 * GET /api/5b992ae7/programs — engine program catalog
 */
router.get('/api/5b992ae7/programs', (_req, res) => {
  res.json({
    programs: Object.values(ENGINE_PROGRAMS).map((program) => ({
      code: program.code,
      name: program.name,
      family: program.family,
      inService: program.inService,
    })),
  });
});

/**
 * POST /api/5b992ae7/portal/error — failure reported by the Flutter portal
 * client after its on-device inquiry flow threw. Raises the Slack alert and
 * Devin session under the portal identity (customer-5b992ae7-portal).
 */
router.post('/api/5b992ae7/portal/error', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const source = typeof body.source === 'string' ? body.source : '';

  if (!source.startsWith('ge-customer-portal/') || body.service !== 'customer-5b992ae7-portal') {
    return res.status(400).json({
      received: false,
      error: 'Expected a ge-customer-portal/<platform> source with service customer-5b992ae7-portal',
    });
  }

  const { reference } = reportPortalFailure(body);

  return res.status(202).json({
    received: true,
    reference,
    service: 'customer-5b992ae7-portal',
    sessionRequested: true,
    receivedAt: new Date().toISOString(),
  });
});

/**
 * POST /api/5b992ae7/inquiry — submit a customer support inquiry
 */
router.post('/api/5b992ae7/inquiry', async (req, res) => {
  // The Flutter portal resolves routing and engine coverage on-device and
  // reports its own failures through its own Sentry/Datadog identity, so a
  // portal submission is registration only: acknowledge the reference number
  // rather than re-running the server-side routing for it.
  const source = typeof req.body.source === 'string' ? req.body.source : '';
  if (source.startsWith('ge-customer-portal/') && req.body.referenceNumber) {
    return res.json({
      success: true,
      referenceNumber: req.body.referenceNumber,
      status: 'registered',
      source,
      receivedAt: new Date().toISOString(),
    });
  }

  try {
    const summary = await submitInquiry({
      topic: req.body.topic || 'commercial-support',
      market: req.body.market || 'US',
      source: req.body.source,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(summary);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'INQUIRY_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
