module.exports = {
  testEnvironment: 'node',
  // `uuid` v13 is ESM-only; map it to a CommonJS stub for Jest's CJS runtime.
  moduleNameMapper: {
    '^uuid$': '<rootDir>/test/uuid-stub.js',
  },
};
