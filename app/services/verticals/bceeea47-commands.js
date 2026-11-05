/**
 * Remote-command catalogue for the connected-vehicle service: each command maps a
 * garage action to the telematics operation sent to the vehicle.
 */
const COMMANDS = [
  { id: 'lock', label: 'Lock', op: 'DOOR_LOCK', timeoutMs: 15000, requiresPin: false },
  { id: 'unlock', label: 'Unlock', op: 'DOOR_UNLOCK', timeoutMs: 15000, requiresPin: true },
  { id: 'remote-start', label: 'Remote start', op: 'ENGINE_START', timeoutMs: 30000, requiresPin: true },
  { id: 'locate', label: 'Find my vehicle', op: 'HORN_LIGHTS', timeoutMs: 10000, requiresPin: false },
];

const COMMAND_INDEX = COMMANDS.reduce((index, command) => {
  index[command.id] = command;
  return index;
}, {});

function resolveCommand(commandId) {
  return Object.hasOwn(COMMAND_INDEX, commandId) ? COMMAND_INDEX[commandId] : null;
}

function basePayload(command, vehicle) {
  return { op: command.op, vin: vehicle.vin, timeoutMs: command.timeoutMs };
}

function buildPayload(command, vehicle, options) {
  const payload = basePayload(command, vehicle);
  if (command.id === 'remote-start') {
    payload.runtimeMinutes = 10;
    payload.climate = {
      preset: options.climate.preset,
      targetTempF: options.climate.targetTempF,
      defrost: Boolean(options.climate.defrost),
    };
  }
  return payload;
}

module.exports = { COMMANDS, resolveCommand, buildPayload };
