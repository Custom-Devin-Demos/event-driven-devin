/**
 * Unit-test + coverage configuration.
 *
 * Coverage is scoped to the pure business logic under src/lib (menu, cart,
 * pricing, loyalty) so the suite runs fast and deterministically in CI without
 * native modules. Chipotle enforces a 90% coverage gate — mirrored here.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  collectCoverage: true,
  collectCoverageFrom: ['src/lib/**/*.ts'],
  coverageReporters: ['text', 'text-summary', 'lcov'],
  coverageThreshold: {
    global: {
      statements: 90,
      branches: 90,
      functions: 90,
      lines: 90,
    },
  },
};
