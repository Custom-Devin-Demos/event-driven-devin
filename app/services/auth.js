const { v4: uuidv4 } = require('uuid');
const logger = require('../telemetry/logger');
const { incrementMetric, recordTiming } = require('../telemetry/datadog');
const { getScenario } = require('../incidentModes');

const DEMO_USERS = {
  buyer_1: { userId: 'usr_b1_acme', name: 'Alice Chen', role: 'buyer', company: 'Acme Corp' },
  buyer_2: { userId: 'usr_b2_acme', name: 'Bob Martinez', role: 'buyer', company: 'Acme Corp' },
  admin_ops: { userId: 'usr_admin_acme', name: 'Carol Nguyen', role: 'admin', company: 'Acme Corp' },
};

async function login(username, password, persona) {
  const startTime = Date.now();
  const scenario = getScenario();

  logger.info('Login attempt', {
    username,
    persona,
    scenario,
    route: '/login',
  });

  // Small processing delay
  await new Promise((resolve) => setTimeout(resolve, 40 + Math.random() * 80));

  const user = DEMO_USERS[persona] || DEMO_USERS.buyer_1;
  const sessionToken = uuidv4();
  const duration = Date.now() - startTime;

  incrementMetric('login.success', {
    route: '/login',
    persona: persona || 'buyer_1',
  });
  recordTiming('login.latency', duration, {
    route: '/login',
    persona: persona || 'buyer_1',
  });

  logger.info('Login successful', {
    userId: user.userId,
    persona,
    durationMs: duration,
    scenario,
  });

  return {
    success: true,
    token: sessionToken,
    user: {
      id: user.userId,
      name: user.name,
      role: user.role,
      company: user.company,
    },
    expiresIn: 3600,
  };
}

module.exports = { login, DEMO_USERS };
