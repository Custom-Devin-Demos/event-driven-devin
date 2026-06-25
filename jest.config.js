module.exports = {
  testEnvironment: 'node',
  moduleNameMapper: {
    // uuid v13 ships ESM only; Jest (CommonJS) cannot require it directly.
    '^uuid$': '<rootDir>/test/mocks/uuid.js',
  },
};
