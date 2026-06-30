module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/*.test.js'],
  moduleNameMapper: {
    // uuid v13 ships ESM only; map to a CommonJS stub so Jest can run without
    // transforming node_modules.
    '^uuid$': '<rootDir>/test/stubs/uuid.js',
  },
};
