// CommonJS stub for the ESM-only `uuid` package, used only under Jest's
// CommonJS test runtime. Backed by Node's built-in crypto.randomUUID.
const { randomUUID } = require('crypto');

module.exports = {
  v4: () => randomUUID(),
};
