// CommonJS stub for the ESM-only `uuid` package, used in Jest tests.
const { randomUUID } = require('crypto');

module.exports = {
  v4: () => randomUUID(),
};
