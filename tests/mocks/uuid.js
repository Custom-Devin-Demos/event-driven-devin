// CommonJS stand-in for the ESM-only `uuid` package under Jest.
const { randomUUID } = require('crypto');

module.exports = { v4: randomUUID };
