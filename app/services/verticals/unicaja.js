const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const CUSTOMER_PROFILES = [
  { id: 'profile-1042', name: 'Sofía Martín', segment: 'individual', preferredLanguage: 'en' },
  { id: 'profile-2178', name: 'Daniel Ortega', segment: 'individual', preferredLanguage: 'es' },
  { id: 'profile-3901', name: 'Marta López', segment: 'premium', preferredLanguage: 'en' },
];

const ACCESS_CHANNELS = [
  { id: 'online', label: 'Web browser', assurance: 'high', factor: 'password-and-key' },
  { id: 'mobile', label: 'Mobile app', assurance: 'high', factor: 'biometric-and-key' },
  { id: 'branch', label: 'Branch support', assurance: 'assisted', factor: 'one-time-key' },
];

function normalizeChannel(channel) {
  return `digital-${channel.id}`.replace(/-/g, '_').toUpperCase();
}

function buildActivationPayload(channels, profile) {
  return channels.reduce((payload, channel) => {
    const key = normalizeChannel(channel);
    payload[key] = {
      profileId: profile.id,
      channelId: channel.id,
      factor: channel.factor,
      assurance: channel.assurance,
      status: 'pending',
    };
    return payload;
  }, {});
}

function mergeChannelSettings(payload, channels) {
  return channels.reduce((settings, channel) => {
    const key = `digital-${channel.id}`;
    settings[key] = {
      ...payload[normalizeChannel(channel)],
      provisioning: {
        issuer: 'digital-access',
        retryLimit: channel.id === 'branch' ? 1 : 3,
      },
    };
    return settings;
  }, {});
}

function createEnrollmentResult(profile, channels) {
  const payload = buildActivationPayload(channels, profile);
  const settings = mergeChannelSettings(payload, channels);
  const activeChannel = channels[0];
  const activation = settings[normalizeChannel(activeChannel)];

  return {
    enrollmentId: uuidv4(),
    profile: { id: profile.id, name: profile.name, segment: profile.segment },
    channel: activeChannel.label,
    securityKey: {
      status: activation.status,
      factor: activation.factor,
      issuer: activation.provisioning.issuer,
    },
    availableChannels: channels.map((channel) => channel.label),
  };
}

async function registerDigitalAccess(data) {
  const requestId = uuidv4();
  const startTime = Date.now();
  const profile = CUSTOMER_PROFILES.find((candidate) => candidate.id === data.profileId)
    || CUSTOMER_PROFILES[0];

  logger.info('Processing digital banking enrollment', {
    requestId,
    profileId: profile.id,
    service: 'customer-unicaja-digital-access',
    route: '/api/unicaja/registration',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 80));
    const result = createEnrollmentResult(profile, ACCESS_CHANNELS);
    result.requestId = requestId;
    result.createdAt = new Date().toISOString();
    incrementMetric('digital_enrollment.success', {
      route: '/api/unicaja/registration',
      segment: profile.segment,
    });
    recordTiming('digital_enrollment.latency', Date.now() - startTime, {
      route: '/api/unicaja/registration',
    });
    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('digital_enrollment.failure', {
      route: '/api/unicaja/registration',
      errorClass: error.name,
    });
    recordTiming('digital_enrollment.latency', duration, {
      route: '/api/unicaja/registration',
      error: 'true',
    });
    logger.error('Digital banking enrollment failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      profileId: profile.id,
      service: 'customer-unicaja-digital-access',
    });
    Sentry.captureException(error, {
      tags: {
        route: '/api/unicaja/registration',
        service: 'customer-unicaja-digital-access',
        profile: profile.segment,
      },
      extra: { requestId, profileId: profile.id },
    });
    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/unicaja.js — createEnrollmentResult',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinOrgId: data.devinOrgId,
      devinEmail: data.devinEmail,
      service: 'customer-unicaja-digital-access',
      verticalLabel: 'Unicaja Banca Digital',
      customer: 'unicaja',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/unicaja/registration' },
        { key: 'service', value: 'customer-unicaja-digital-access' },
        { key: 'profile', value: profile.segment },
      ],
      extra: { requestId, profileId: profile.id },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: 'unicaja-banca-digital@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for digital banking error', {
        error: alertError.message,
        requestId,
      });
    });
    throw error;
  }
}

module.exports = {
  registerDigitalAccess,
  CUSTOMER_PROFILES,
  ACCESS_CHANNELS,
};
