module.exports = {
  testEnvironment: 'node',
  // uuid v13 ships ESM only, which Jest's CommonJS runtime cannot import.
  // It is only used to generate a request-id string, so map it to a CJS stub.
  moduleNameMapper: {
    '^uuid$': '<rootDir>/test/uuid-stub.js',
  },
};
