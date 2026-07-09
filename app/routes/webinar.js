const express = require('express');
const fs = require('fs');
const path = require('path');

const logger = require('../telemetry/logger');
const { sendEmail } = require('../services/email');
const { appendSignup } = require('../services/sheets');

const router = express.Router();

const SIGNUPS_DIR = path.join(__dirname, '..', '..', 'data');
const SIGNUPS_FILE = path.join(SIGNUPS_DIR, 'webinar-signups.json');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_FIELD_LEN = 200;

const WEBINAR_NAME = 'Cognition Platform Webinar for Humana Leaders';
const WEBINAR_WHEN = 'Thursday, July 24 at 12:00 PM EST';
const ALERT_FROM = process.env.WEBINAR_FROM_EMAIL || 'quinn.hilgartner@cognition.ai';
const ALERT_RECIPIENTS = (process.env.WEBINAR_ALERT_RECIPIENTS ||
  'quinn.hilgartner@cognition.ai,bain.schroeder@cognition.ai')
  .split(',')
  .map((e) => e.trim())
  .filter(Boolean);

function sendSignupAlert({ name, title, email, registeredAt }) {
  const subject = `New webinar signup: ${name} (${title})`;
  const text = [
    `A new registration came in for the ${WEBINAR_NAME}.`,
    ``,
    `Name:  ${name}`,
    `Title: ${title}`,
    `Email: ${email}`,
    ``,
    `Webinar: ${WEBINAR_WHEN}`,
    `Registered at: ${registeredAt}`,
  ].join('\n');

  return sendEmail({ from: ALERT_FROM, to: ALERT_RECIPIENTS, subject, text })
    .then((r) => {
      if (!r.ok) {
        logger.warn('webinar.signup.alert_failed', { status: r.status, error: r.error, body: r.body });
      }
    })
    .catch((err) => logger.warn('webinar.signup.alert_error', { error: err.message }));
}

function readSignups() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SIGNUPS_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    // Only treat a missing file as "no signups yet". A parse error means the
    // file is present but corrupted, so fail loudly rather than silently
    // overwriting existing registrations.
    if (err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}

function writeSignups(signups) {
  fs.mkdirSync(SIGNUPS_DIR, { recursive: true });
  fs.writeFileSync(SIGNUPS_FILE, JSON.stringify(signups, null, 2));
}

// Serve the webinar landing page
router.get('/webinar', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'webinar.html'));
});

// Capture a webinar registration
router.post('/api/webinar/signup', (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
  const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';

  if (!name || !title || !email) {
    return res.status(400).json({ success: false, error: 'Name, title, and email are all required.' });
  }
  if (name.length > MAX_FIELD_LEN || title.length > MAX_FIELD_LEN || email.length > MAX_FIELD_LEN) {
    return res.status(400).json({ success: false, error: 'One or more fields are too long.' });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ success: false, error: 'Please enter a valid email address.' });
  }

  const registeredAt = new Date().toISOString();
  try {
    const signups = readSignups();
    signups.push({ name, title, email, registeredAt });
    writeSignups(signups);
  } catch (err) {
    logger.error('webinar.signup.persist_failed', { error: err.message });
    return res.status(500).json({ success: false, error: 'Could not save your registration. Please try again in a moment.' });
  }

  // Fire-and-forget alert email; never blocks or fails the registration.
  sendSignupAlert({ name, title, email, registeredAt });

  // Fire-and-forget append to the Google Sheet; never blocks the registration.
  appendSignup({ name, title, email, registeredAt })
    .catch((err) => logger.warn('webinar.signup.sheet_error', { error: err.message }));

  return res.json({ success: true });
});

module.exports = router;
