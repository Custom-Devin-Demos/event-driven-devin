module.exports = {
  testEnvironment: 'node',
  // uuid v13 ships ESM-only; map it to a lightweight CommonJS stub so the
  // CommonJS test runner can require modules that depend on it.
  moduleNameMapper: {
    '^uuid$': '<rootDir>/test/mocks/uuid.js',
  },
};
