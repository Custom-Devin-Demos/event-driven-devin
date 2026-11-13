const { createHash, randomUUID } = require('crypto');
const logger = require('../../telemetry/logger');

const CUSTOMER = '128703d6';
const SERVICE = 'customer-128703d6-esignature';
const MAX_ENVELOPES = 500;
const DEMO_ID = /^[A-Za-z0-9-]{8,64}$/;
const SIGNER_NAME = /^[\p{L}\p{M}' .-]{2,60}$/u;
const DEFAULT_SIGNER = { name: 'Alex Rivera', email: 'alex.rivera@contoso-health.com', company: 'Contoso Health' };
const SENDER = { name: 'Morgan Patel', email: 'morgan.patel@northwindsystems.com', company: 'Northwind Systems, Inc.', title: 'Chief Revenue Officer' };
const DOCUMENT = { id: '1', name: 'Northwind_Contoso_Order_Form_2027.pdf', pages: 2 };
const TABS = [
  { id: 'initial-1', type: 'initialHere', page: 1, required: true, label: 'Initial' },
  { id: 'sign-1', type: 'signHere', page: 2, required: true, label: 'Sign' },
  { id: 'title-1', type: 'text', page: 2, required: true, label: 'Title', maxLength: 60 },
  { id: 'fullname-1', type: 'fullName', page: 2, required: false, label: 'Full Name' },
  { id: 'date-1', type: 'dateSigned', page: 2, required: false, label: 'Date Signed' },
];
const SIGNATURE_STYLES = ['dancing-script', 'homemade-apple', 'mrs-saint-delafield', 'caveat'];
const envelopes = new Map();

const invalid = (message, code = 'INVALID_REQUEST') => Object.assign(new Error(message), { name: 'ValidationError', status: 400, code });
const hexId = seed => createHash('sha256').update(seed).digest('hex').toUpperCase();
const envelopeIdFor = seed => {
  const h = hexId(`envelope:${seed}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

function demoKey(demoId) {
  if (typeof demoId !== 'string' || !DEMO_ID.test(demoId)) throw invalid('A valid demo session id is required.', 'INVALID_DEMO_ID');
  return demoId;
}

function signerFor(name) {
  if (name === undefined || name === null || name === '') return { ...DEFAULT_SIGNER };
  const clean = String(name).trim().replace(/\s+/g, ' ');
  if (!SIGNER_NAME.test(clean)) throw invalid('Signer name may only contain letters, spaces, apostrophes, periods and hyphens.', 'INVALID_SIGNER');
  const email = `${clean.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '') || 'signer'}@contoso-health.com`;
  return { ...DEFAULT_SIGNER, name: clean, email };
}

function initialsOf(name) {
  return name.split(/[\s-]+/).filter(Boolean).map(part => part[0].toUpperCase()).slice(0, 3).join('');
}

function createEnvelope(key, signerName) {
  const now = Date.now();
  const sentAt = new Date(now - 18 * 60 * 1000).toISOString();
  const envelope = {
    envelopeId: envelopeIdFor(`${key}:${now}`),
    status: 'sent',
    subject: `Please DocuSign: ${DOCUMENT.name}`,
    emailBlurb: `Hi, attached is the 2027 enterprise order form we reviewed on Tuesday. Please review and sign at your convenience. Thank you!`,
    sender: SENDER,
    signer: signerFor(signerName),
    document: DOCUMENT,
    tabs: TABS,
    sentAt,
    deliveredAt: null,
    completedAt: null,
    values: {},
    signature: null,
    history: [
      { at: new Date(now - 26 * 60 * 1000).toISOString(), action: 'Registered', by: SENDER.name, detail: 'The envelope was created' },
      { at: new Date(now - 19 * 60 * 1000).toISOString(), action: 'Signed', by: SENDER.name, detail: 'Sender countersigned in advance' },
      { at: sentAt, action: 'Sent Invitations', by: SENDER.name, detail: 'Invitation sent to the recipient' },
    ],
  };
  envelopes.delete(key);
  envelopes.set(key, envelope);
  while (envelopes.size > MAX_ENVELOPES) envelopes.delete(envelopes.keys().next().value);
  return envelope;
}

function getEnvelope(demoId, { signerName } = {}) {
  const key = demoKey(demoId);
  const existing = envelopes.get(key);
  if (existing && (signerName === undefined || signerName === '' || existing.signer.name === signerFor(signerName).name)) return existing;
  return createEnvelope(key, signerName);
}

function markViewed(demoId, { signerName } = {}) {
  const envelope = getEnvelope(demoId, { signerName });
  if (envelope.status === 'sent') {
    envelope.status = 'delivered';
    envelope.deliveredAt = new Date().toISOString();
    envelope.history.push({ at: envelope.deliveredAt, action: 'Viewed', by: envelope.signer.name, detail: 'Recipient opened the envelope and accepted the Electronic Record and Signature Disclosure' });
  }
  return envelope;
}

function validateSignature(signature, signer) {
  if (!signature || typeof signature !== 'object' || Array.isArray(signature)) throw invalid('Adopt a signature before finishing.', 'SIGNATURE_REQUIRED');
  const fullName = typeof signature.fullName === 'string' ? signature.fullName.trim().replace(/\s+/g, ' ') : '';
  const initials = typeof signature.initials === 'string' ? signature.initials.trim().toUpperCase() : '';
  if (!SIGNER_NAME.test(fullName)) throw invalid('Enter your full name to adopt a signature.', 'SIGNATURE_REQUIRED');
  if (!/^[\p{Lu}]{1,4}$/u.test(initials)) throw invalid('Enter your initials (up to 4 letters).', 'SIGNATURE_REQUIRED');
  if (signature.mode === 'draw') {
    if (typeof signature.image !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signature.image) || signature.image.length > 400000) {
      throw invalid('Draw your signature before adopting it.', 'SIGNATURE_REQUIRED');
    }
  } else if (!SIGNATURE_STYLES.includes(signature.style)) {
    throw invalid('Choose a signature style.', 'SIGNATURE_REQUIRED');
  }
  return {
    fullName, initials, mode: signature.mode === 'draw' ? 'draw' : 'style', style: signature.mode === 'draw' ? null : signature.style,
    image: signature.mode === 'draw' ? signature.image : null, signerName: signer.name,
  };
}

function validateTabs(values = {}) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw invalid('Complete the required fields.', 'REQUIRED_FIELDS');
  const missing = [];
  if (values['initial-1'] !== true) missing.push('Initial');
  if (values['sign-1'] !== true) missing.push('Sign');
  const title = typeof values['title-1'] === 'string' ? values['title-1'].trim() : '';
  if (!title) missing.push('Title');
  if (missing.length) throw Object.assign(invalid(`Complete the required fields: ${missing.join(', ')}.`, 'REQUIRED_FIELDS'), { missing });
  if (title.length > 60) throw invalid('Title must be 60 characters or fewer.', 'REQUIRED_FIELDS');
  return { 'initial-1': true, 'sign-1': true, 'title-1': title };
}

// Completion pipeline: each step runs in order before the envelope is sealed.
const COMPLETION_STEPS = [
  function stampDateSigned(envelope, ctx) {
    ctx.values['date-1'] = new Date(ctx.completedAt).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    ctx.values['fullname-1'] = ctx.signature.fullName;
  },
  function assignSignatureId(envelope, ctx) {
    ctx.signature.signatureId = hexId(`${envelope.envelopeId}:${ctx.signature.fullName}:${ctx.completedAt}`).slice(0, 32);
    ctx.signature.shortId = ctx.signature.signatureId.slice(0, 15);
  },
  function sealCertificate(envelope, ctx) {
    ctx.certificate = {
      envelopeId: envelope.envelopeId,
      documentHash: hexId(`${envelope.envelopeId}:${DOCUMENT.name}:${JSON.stringify(ctx.values)}`).slice(0, 40),
      signatureAdoption: ctx.signature.mode === 'draw' ? 'Drawn on Device' : 'Pre-selected Style',
      ipAddress: '203.0.113.24',
      completedAt: ctx.completedAt,
    };
  },
];

function completeEnvelope(demoId, { values, signature } = {}) {
  const envelope = getEnvelope(demoId);
  if (envelope.status === 'completed') return envelope;
  const ctx = { values: validateTabs(values), signature: validateSignature(signature, envelope.signer), completedAt: new Date().toISOString() };
  for (const step of COMPLETION_STEPS) step(envelope, ctx);
  Object.assign(envelope, { status: 'completed', completedAt: ctx.completedAt, values: ctx.values, signature: ctx.signature, certificate: ctx.certificate });
  envelope.history.push(
    { at: ctx.completedAt, action: 'Signed', by: envelope.signer.name, detail: `Signature adopted: ${ctx.certificate.signatureAdoption}` },
    { at: ctx.completedAt, action: 'Completed', by: 'Docusign', detail: 'All parties have signed. Completed copies sent to all recipients' },
  );
  logger.info('Envelope completed', { service: SERVICE, customer: CUSTOMER, envelopeId: envelope.envelopeId, requestId: randomUUID() });
  return envelope;
}

function resetEnvelope(demoId, { signerName } = {}) {
  return createEnvelope(demoKey(demoId), signerName);
}

module.exports = {
  CUSTOMER, SERVICE, TABS, SIGNATURE_STYLES, DEFAULT_SIGNER, SENDER, DOCUMENT, COMPLETION_STEPS,
  getEnvelope, markViewed, completeEnvelope, resetEnvelope, initialsOf, signerFor,
  _envelopes: envelopes,
};
