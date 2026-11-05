const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { COMMANDS, resolveCommand, buildPayload } = require('./bceeea47-commands');

const SERVICE = 'bceeea47-api';
const ROUTE = '/api/bceeea47/remote-commands';

const VEHICLE = {
  vin: '1HGCY2F8XRA******',
  nickname: 'Accord',
  model: '2024 Accord Hybrid Touring',
  color: 'Platinum White Pearl',
  odometerMiles: 12840,
  fuelPercent: 62,
  rangeMiles: 388,
  evRangeMiles: 0,
  tirePressureOk: true,
  oilLifePercent: 70,
  nextServiceMiles: 15000,
  lastSync: null,
  doors: 'locked',
  engine: 'off',
  climateDefaults: { preset: 'comfort', targetTempF: 70, defrost: false },
};

const ACTIVITY = [];
let resetEpoch = 0;
let inFlight = 0;
let degradedBy = null;

function syncVehicle(commandId) {
  if (commandId === 'lock') VEHICLE.doors = 'locked';
  if (commandId === 'unlock') VEHICLE.doors = 'unlocked';
  if (commandId === 'remote-start') VEHICLE.engine = 'running';
  VEHICLE.lastSync = new Date().toISOString();
}

function platformStatus() {
  if (degradedBy) {
    return { state: 'degraded', text: 'Remote services degraded', detail: `${degradedBy} failing for owners` };
  }
  return { state: 'ok', text: 'Remote services operational', detail: 'all commands available' };
}

function getGarage() {
  return {
    vehicle: VEHICLE,
    commands: COMMANDS.map(({ id, label, requiresPin }) => ({ id, label, requiresPin })),
    activity: ACTIVITY.slice(0, 8),
    status: platformStatus(),
  };
}

function record(entry) {
  ACTIVITY.unshift(entry);
  ACTIVITY.splice(20);
}

async function dispatchRemoteCommand(data) {
  const startTime = Date.now();
  const epoch = resetEpoch;
  const requestId = uuidv4();
  const command = resolveCommand(data.commandId);
  inFlight += 1;

  try {
    if (!command) {
      const err = new Error(`Unknown remote command: ${data.commandId}`);
      err.statusCode = 400;
      throw err;
    }

    logger.info('Dispatching remote command', { requestId, commandId: command.id, service: SERVICE });

    const payload = buildPayload(command, VEHICLE, { pin: data.pin });
    await new Promise((resolve) => setTimeout(resolve, 600 + Math.random() * 500));

    syncVehicle(command.id);
    const entry = {
      requestId,
      commandId: command.id,
      label: command.label,
      status: 'complete',
      at: new Date().toISOString(),
      durationMs: Date.now() - startTime,
    };
    if (epoch === resetEpoch) record(entry);

    incrementMetric('remote_command.success', { route: ROUTE, command: command.id });
    recordTiming('remote_command.latency', Date.now() - startTime, { route: ROUTE, command: command.id });
    return { success: true, requestId, payload: { op: payload.op }, vehicle: VEHICLE, activity: entry, status: platformStatus() };
  } catch (error) {
    if (error.statusCode === 400) throw error;

    const duration = Date.now() - startTime;
    const commandId = command ? command.id : data.commandId;
    const label = command ? command.label : data.commandId;

    incrementMetric('remote_command.failure', { route: ROUTE, command: commandId, errorClass: error.name });
    recordTiming('remote_command.latency', duration, { route: ROUTE, command: commandId, error: 'true' });

    logger.error('Remote command failed', {
      requestId,
      commandId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: SERVICE,
    });

    if (epoch === resetEpoch) {
      degradedBy = label;
      record({
        requestId,
        commandId,
        label,
        status: 'failed',
        error: `${error.name}: ${error.message}`,
        at: new Date().toISOString(),
        durationMs: duration,
      });
    }

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, command: commandId, alert_path: 'instant' },
      extra: { requestId, vin: VEHICLE.vin },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/bceeea47.js — dispatchRemoteCommand',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Connected Vehicle — Remote Services',
      skipVulnerablePr: true,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'command', value: commandId },
      ],
      extra: {
        requestId,
        commandId,
        vehicle: { model: VEHICLE.model, vin: VEHICLE.vin },
        promptContext: `Owners pressing "${label}" from the My Garage page receive HTTP 500 and the command never reaches the vehicle. Lock, Unlock and Find my vehicle succeed. The remote-command payload is built in app/services/verticals/bceeea47-commands.js from the options passed by dispatchRemoteCommand in app/services/verticals/bceeea47.js.`,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'bceeea47@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
      promptAppendix: 'Fix Remote start so the command succeeds for every vehicle, using the owner\'s saved climate settings when the request does not supply any. Add a regression test in tests/ covering the remote-start command, and verify the fix in the browser on /bceeea47 by pressing Remote start.',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from remote command error', { error: err.message });
    });

    throw error;
  } finally {
    inFlight -= 1;
  }
}

function resetGarage() {
  if (inFlight > 0) {
    return { success: false, reason: 'A remote command is in flight; retry once it finishes.', status: platformStatus() };
  }
  resetEpoch += 1;
  const cleared = ACTIVITY.length;
  ACTIVITY.length = 0;
  degradedBy = null;
  VEHICLE.doors = 'locked';
  VEHICLE.engine = 'off';
  VEHICLE.lastSync = null;
  logger.info('Demo state reset', { cleared, service: SERVICE });
  incrementMetric('remote_command.reset', { route: `${ROUTE}/reset` });
  return { success: true, cleared, status: platformStatus() };
}

module.exports = { dispatchRemoteCommand, resetGarage, getGarage, VEHICLE, COMMANDS };
