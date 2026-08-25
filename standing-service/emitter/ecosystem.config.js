'use strict';

// PM2 process file for the droplet: the service itself plus the 24/7 emitter.
module.exports = {
  apps: [
    {
      name: 'automations-service',
      cwd: '../template',
      script: 'src/index.js',
      max_restarts: 50,
      restart_delay: 5000,
    },
    {
      name: 'automations-emitter',
      script: 'emitter.js',
      max_restarts: 50,
      restart_delay: 5000,
    },
  ],
};
