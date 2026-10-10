const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:3101',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node app/server.js',
    url: 'http://127.0.0.1:3101/health',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
    env: {
      PORT: '3101',
      DD_TRACE_ENABLED: 'false',
      SLACK_BOT_TOKEN: '',
      SLACK_CHANNEL_ID: '',
      DEVIN_SERVICE_KEY: '',
      DEVIN_SERVICE_KEY_77560B41: '',
      DEVIN_API_KEY: '',
      DEVIN_API_KEY_77560B41: '',
      DEVIN_USER_ID: '',
      DEVIN_USER_ID_77560B41: '',
      DEVIN_ORG_ID: '',
      DEVIN_ORG_ID_77560B41: '',
      SLACK_CHANNEL_ID_77560B41: '',
      SLACK_USER_TOKEN: '',
      SENTRY_DSN: '',
      SENTRY_CLIENT_SECRET: '',
      SENTRY_ORG_SLUG: '',
      SENTRY_PROJECT_ID: '',
      SENTRY_RELEASE: '',
    },
  },
});
