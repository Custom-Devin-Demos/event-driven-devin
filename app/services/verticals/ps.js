const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Care team members shown in the PerfectServe directory picker.
 */
const CONTACTS = [
  { id: 'fiscus-wayne', name: 'Fiscus, Wayne', role: 'Registered Nurse', presence: 'available', pinned: true },
  { id: 'alvarez-antonio', name: 'Alvarez, Antonio', role: 'Hospitalist', presence: 'busy', pinned: true },
  { id: 'gregory-susan', name: 'Gregory, Susan', role: 'Hospitalist', presence: 'busy', pinned: false },
  { id: 'patel-meera', name: 'Patel, Meera', role: 'Cardiology Fellow', presence: 'available', pinned: false },
  { id: 'okafor-daniel', name: 'Okafor, Daniel', role: 'Charge Nurse, PACU', presence: 'available', pinned: false },
  { id: 'nguyen-linh', name: 'Nguyen, Linh', role: 'Pharmacist', presence: 'offline', pinned: false },
  { id: 'bishop-ellie', name: 'Bishop, Ellie', role: 'Registered Nurse', presence: 'available', pinned: false },
];

/**
 * Message types offered in the compose form, each with a delivery priority.
 */
const MESSAGE_TYPES = [
  { id: 'general', label: 'General', priority: 'normal', readReceipt: true },
  { id: 'consult', label: 'Consult Request', priority: 'high', readReceipt: true },
  { id: 'critical_lab', label: 'Critical Lab Result', priority: 'stat', readReceipt: true },
  { id: 'rrt', label: 'Rapid Response', priority: 'stat', readReceipt: true },
];

/**
 * Patient encounters shown in the Patient Encounter picker.
 */
const ENCOUNTERS = [
  {
    id: 'enc-anthony',
    patient: 'Aaliyah, Anthony',
    admitted: 'Aug 19, 2020 4:25 AM',
    unit: 'A | PICU | 9-A',
    sex: '-',
    dob: 'Mar 3, 2017',
    mrn: '9f2c81aa04',
  },
  {
    id: 'enc-charles',
    patient: 'Aaliyah, Charles',
    admitted: 'Aug 19, 2020 4:17 AM',
    unit: 'A | PACU | 3-C',
    sex: 'Female',
    dob: 'Feb 11, 2000',
    mrn: '5cb3e34bdd',
  },
  {
    id: 'enc-claire',
    patient: 'Aaliyah, Claire',
    admitted: 'Aug 19, 2020 4:10 AM',
    unit: 'A | NICU | 8-C',
    sex: 'Female',
    dob: 'Aug 2, 2020',
    mrn: '71dd90b2e6',
  },
  {
    id: 'enc-jacob',
    patient: 'Aaliyah, Jacob',
    admitted: 'Aug 19, 2020 4:05 AM',
    unit: 'A | MS3 | 10-B',
    sex: 'Female',
    dob: 'Nov 27, 1998',
    mrn: 'c48a01f733',
  },
];

/**
 * Escalation window (minutes) before an unacknowledged message escalates,
 * keyed by message-type priority.
 */
const ESCALATION_MINUTES = {
  normal: 20,
  high: 10,
  stat: 5,
};

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the PerfectServe secure messaging vertical:',
  '- Service: `app/services/verticals/ps.js`',
  '- Route: `app/routes/verticals/ps.js`',
  '- Page: `app/public/verticals/ps.html` (served at `/ps` and `/perfectserve`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function findContact(contactId) {
  return CONTACTS.find((contact) => contact.id === contactId);
}

function findMessageType(typeId) {
  return MESSAGE_TYPES.find((type) => type.id === typeId);
}

function findEncounter(encounterId) {
  return ENCOUNTERS.find((enc) => enc.id === encounterId);
}

/**
 * Build the message thread object: subscribers (the sender plus the selected
 * participants) and the routing header for Dynamic Intelligent Routing.
 */
function createThread(sender, participants, type, encounter, body, callbackNumber) {
  const now = new Date().toISOString();
  const subscribers = [sender].concat(participants).map((contact) => ({
    contactId: contact.id,
    name: contact.name,
    role: contact.role,
    addedAt: now,
  }));

  return {
    threadId: `THR-${uuidv4().slice(0, 8).toUpperCase()}`,
    subject: type.label,
    encounterId: encounter ? encounter.id : null,
    callbackNumber: callbackNumber || null,
    sentAt: now,
    subscribers,
    messages: [
      {
        id: `MSG-${uuidv4().slice(0, 8).toUpperCase()}`,
        from: sender.id,
        body,
        sentAt: now,
        status: 'sent',
      },
    ],
    routing: {
      policy: 'dynamic-intelligent-routing',
      escalationMinutes: ESCALATION_MINUTES[type.priority] || ESCALATION_MINUTES.normal,
      attempts: [],
    },
  };
}

/**
 * Dynamic Intelligent Routing: pick a delivery channel per participant from
 * their live presence and record each attempt on the thread's routing log.
 */
function routeToRecipients(thread, participants) {
  for (const participant of participants) {
    let channel;
    if (participant.presence === 'available') {
      channel = 'app_push';
    } else if (participant.presence === 'busy') {
      channel = 'app_push+sms';
    } else {
      channel = 'pager';
    }

    thread.routing.deliveryAttempts.push({
      contactId: participant.id,
      name: participant.name,
      channel,
      attemptedAt: new Date().toISOString(),
      result: 'delivered',
    });
  }

  return thread.routing.deliveryAttempts;
}

/**
 * Send a secure clinical message to the selected care team members.
 */
async function sendMessage(data) {
  const startTime = Date.now();
  const sendId = uuidv4();

  logger.info('Sending secure message', {
    sendId,
    messageType: data.messageType,
    participantCount: Array.isArray(data.participantIds) ? data.participantIds.length : 0,
    encounterId: data.encounterId || null,
    service: 'customer-ps-secure-messaging',
    route: '/api/ps/messages',
  });

  if (!Array.isArray(data.participantIds) || data.participantIds.length === 0) {
    const error = new Error('At least one participant is required');
    error.name = 'ValidationError';
    error.statusCode = 400;
    error.code = 'NO_PARTICIPANTS';
    throw error;
  }

  const participants = [];
  for (const participantId of data.participantIds) {
    const contact = findContact(participantId);
    if (!contact) {
      const error = new Error(`Unknown participant: ${participantId}`);
      error.name = 'ValidationError';
      error.statusCode = 400;
      error.code = 'PARTICIPANT_NOT_FOUND';
      throw error;
    }
    participants.push(contact);
  }

  const type = findMessageType(data.messageType);
  if (!type) {
    const error = new Error(`Unknown message type: ${data.messageType || '(none)'}`);
    error.name = 'ValidationError';
    error.statusCode = 400;
    error.code = 'INVALID_MESSAGE_TYPE';
    throw error;
  }

  if (typeof data.message !== 'string' || data.message.trim() === '') {
    const error = new Error('Message body must not be empty');
    error.name = 'ValidationError';
    error.statusCode = 400;
    error.code = 'EMPTY_MESSAGE';
    throw error;
  }

  let encounter = null;
  if (data.encounterId) {
    encounter = findEncounter(data.encounterId);
    if (!encounter) {
      const error = new Error(`Unknown patient encounter: ${data.encounterId}`);
      error.name = 'ValidationError';
      error.statusCode = 400;
      error.code = 'ENCOUNTER_NOT_FOUND';
      throw error;
    }
  }

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const sender = findContact('bishop-ellie');
    const thread = createThread(sender, participants, type, encounter, data.message.trim(), data.callbackNumber);
    const deliveries = routeToRecipients(thread, participants);

    const result = {
      threadId: thread.threadId,
      subject: thread.subject,
      sentAt: thread.sentAt,
      subscribers: thread.subscribers.map((sub) => ({
        name: sub.name,
        role: sub.role,
        status: deliveries.some((d) => d.contactId === sub.contactId && d.result === 'delivered' && sub.contactId !== sender.id)
          ? 'Sent'
          : 'Read',
        addedAt: sub.addedAt,
      })),
      messages: thread.messages,
      routing: {
        policy: thread.routing.policy,
        deliveries,
      },
    };

    incrementMetric('secure_message.sent', {
      route: '/api/ps/messages',
      messageType: data.messageType,
    });
    recordTiming('secure_message.latency', Date.now() - startTime, {
      route: '/api/ps/messages',
      error: 'false',
    });

    logger.info('Secure message sent', {
      sendId,
      threadId: thread.threadId,
      messageType: data.messageType,
      participantCount: participants.length,
    });

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('secure_message.failure', {
      route: '/api/ps/messages',
      errorClass: error.name,
      messageType: data.messageType,
    });
    recordTiming('secure_message.latency', duration, {
      route: '/api/ps/messages',
      error: 'true',
    });

    logger.error('Secure message failed', {
      sendId,
      messageType: data.messageType,
      participantCount: participants.length,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: 'customer-ps-secure-messaging',
    });

    Sentry.captureException(error, {
      tags: {
        service: 'customer-ps-secure-messaging',
        route: '/api/ps/messages',
        messageType: data.messageType,
        participantCount: String(participants.length),
      },
      extra: {
        sendId,
        messageType: data.messageType,
        participants: participants.map((p) => p.name),
        encounterId: data.encounterId || null,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/ps.js — routeToRecipients',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-ps-secure-messaging',
      verticalLabel: 'PerfectServe Secure Messaging',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 'ps',
      slackMemberId: 'U0BQZBHCNMA',
      tags: [
        { key: 'route', value: '/api/ps/messages' },
        { key: 'service', value: 'customer-ps-secure-messaging' },
        { key: 'messageType', value: data.messageType },
        { key: 'participantCount', value: String(participants.length) },
      ],
      extra: {
        sendId,
        messageType: data.messageType,
        participants: participants.map((p) => p.name),
        encounterId: data.encounterId || null,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
    }).catch((alertError) => {
      logger.error('Failed to post alert for secure message error', {
        sendId,
        error: alertError.message,
      });
    });

    throw error;
  }
}

module.exports = {
  sendMessage,
  CONTACTS,
  MESSAGE_TYPES,
  ENCOUNTERS,
};
