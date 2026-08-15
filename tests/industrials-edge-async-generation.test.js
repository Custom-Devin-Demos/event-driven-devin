jest.mock('child_process', () => ({
  execFile: jest.fn((command, args, options, callback) => {
    setTimeout(() => callback(new Error('openssl test failure')), 25);
  }),
}));

const {
  cleanupCertificateMaterial,
  ensureCertificateMaterial,
  runOpenSSL,
  startGateway,
} = require('../app/services/oncall-verticals/industrials-edge');

describe('industrials edge certificate generation', () => {
  test('allows the event loop to run while OpenSSL is in flight', async () => {
    let timerFired = false;
    const openssl = runOpenSSL(['version'], process.cwd());
    const generation = ensureCertificateMaterial();
    const warmup = startGateway();
    const timer = new Promise((resolve) => {
      setTimeout(() => {
        timerFired = true;
        resolve();
      }, 0);
    });

    await timer;

    expect(timerFired).toBe(true);
    await expect(openssl).rejects.toThrow('openssl test failure');
    await expect(generation).resolves.toBeNull();
    await expect(warmup).resolves.toBeNull();
    cleanupCertificateMaterial();
  });
});
