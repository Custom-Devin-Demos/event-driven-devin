const express = require('express');
const path = require('path');
const fs = require('fs');
const { scheduleAppointment, ValidationError } = require('../../services/verticals/e7fd3fee');
const erica = require('../../services/verticals/e7fd3fee-erica');

const router = express.Router();
const OLB_DIR = path.join(__dirname, '..', '..', 'public', 'verticals', 'e7fd3fee-olb');
const olbForm = express.urlencoded({ extended: false });

router.get('/e7fd3fee/olb', (_req, res) => res.redirect('/e7fd3fee/olb/login'));
router.use('/e7fd3fee/olb/assets', express.static(path.join(OLB_DIR, 'assets')));
router.get('/e7fd3fee/olb/keepalive', (_req, res) => res.status(204).end());
router.get('/e7fd3fee/olb/account-reveal', (_req, res) => res.status(403).json({ error: 'Full account numbers are hidden in this demo.' }));

router.post('/e7fd3fee/olb/login', olbForm, (req, res) => {
  const body = req.body || {};
  res.redirect(303, body.passcode ? '/e7fd3fee/olb/verify' : '/e7fd3fee/olb/login-passcode');
});
router.post('/e7fd3fee/olb/verify', olbForm, (_req, res) => res.redirect(303, '/e7fd3fee/olb/accounts'));

router.get('/e7fd3fee/olb/:page', (req, res) => {
  const page = String(req.params.page).replace(/[^a-z0-9_-]/gi, '');
  const file = path.join(OLB_DIR, `${page}.html`);
  if (!fs.existsSync(file)) {
    res.redirect('/e7fd3fee/olb/accounts');
    return;
  }
  res.sendFile(file);
});
router.post('/e7fd3fee/olb/:page', olbForm, (req, res) => {
  res.redirect(303, `/e7fd3fee/olb/${String(req.params.page).replace(/[^a-z0-9_-]/gi, '')}`);
});

router.post('/api/e7fd3fee/erica/chat', (req, res) => {
  const body = req.body || {};
  try {
    res.json(erica.chat({
      text: typeof body.text === 'string' ? body.text.slice(0, 500) : '',
      action: body.action,
      locale: body.locale,
      sessionKey: req.get('X-CSRF-Token') || req.ip,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    }));
  } catch (error) {
    res.status(500).json({
      error: {
        code: 'ERICA_ACTION_FAILED',
        message: "Erica couldn't file your dispute. Nothing has changed.",
        errorClass: error.name,
        correlation_id: error.referenceId || req.requestId,
      },
      messages: error.ericaMessages,
    });
  }
});

router.get('/e7fd3fee', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'verticals', 'e7fd3fee.html'));
});

router.post('/api/e7fd3fee/appointments', async (req, res) => {
  const body = req.body || {};

  try {
    const result = await scheduleAppointment({
      topic: body.topic,
      channel: body.channel,
      centerId: body.centerId,
      date: body.date,
      time: body.time,
      firstName: body.firstName,
      lastName: body.lastName,
      email: body.email,
      phone: body.phone,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    if (error instanceof ValidationError) {
      res.status(400).json({
        success: false,
        error: error.message,
        errorClass: 'ValidationError',
        code: 'INVALID_APPOINTMENT_REQUEST',
      });
      return;
    }
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: 'APPOINTMENT_BOOKING_FAILED',
      referenceId: error.referenceId || req.requestId,
    });
  }
});

module.exports = router;
