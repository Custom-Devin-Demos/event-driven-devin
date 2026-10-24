const { v4: uuidv4 } = require('uuid');
const { SETTLEMENT_LOCATIONS, HOLIDAYS, isBusinessDay } = require('./87575bac-calendars');

/**
 * Depository gateway. Settlement instructions are validated against the
 * depository's own settlement calendar before they are accepted.
 */

class DepositoryRejectionError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'DepositoryRejectionError';
    this.code = 'SSI_REJECTED';
    this.statusCode = 422;
    this.details = details;
  }
}

function submitInstruction(instruction) {
  const location = SETTLEMENT_LOCATIONS[instruction.depository];
  if (!location) {
    throw new DepositoryRejectionError(`Unknown depository ${instruction.depository}. Instruction rejected.`, { instruction });
  }

  if (!isBusinessDay(instruction.settleDate, location.country)) {
    throw new DepositoryRejectionError(
      `${location.short} Rejection: Settlement date ${instruction.settleDate} is not a valid settlement day for ${location.short}. Instruction rejected.`,
      {
        depository: location.code,
        settleDate: instruction.settleDate,
        depositoryHoliday: (HOLIDAYS[location.country] || {})[instruction.settleDate] || null,
        reasonCode: 'SDTE',
      },
    );
  }

  return {
    accepted: true,
    depository: location.code,
    reference: `${location.code}-${instruction.settleDate.replace(/-/g, '')}-${uuidv4().slice(0, 8).toUpperCase()}`,
    settleDate: instruction.settleDate,
  };
}

module.exports = { DepositoryRejectionError, submitInstruction };
