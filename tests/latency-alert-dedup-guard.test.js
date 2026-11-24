/* global describe, expect, test */

const fs = require('fs');
const path = require('path');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');

const VERTICALS_DIR = path.join(__dirname, '../app/services/verticals');
const LATENCY_SERVICES = fs.readdirSync(VERTICALS_DIR)
  .filter((file) => /^[0-9a-f]{8}\.js$/i.test(file))
  .map((file) => ({
    id: path.basename(file, '.js'),
    source: fs.readFileSync(path.join(VERTICALS_DIR, file), 'utf8'),
  }))
  .filter(({ source }) => source.includes('LatencyBudgetExceeded') && source.includes('createSessionAndAlert('));

// pre-existing verticals; new latency demos must use claimLatencyAlert
const GRANDFATHERED_WITHOUT_SHARED_COOLDOWN = [
  '0166f378',
  '04525b56',
  '2ecabf0c',
  '2fbca1a9',
  '37b90289',
  '3c9e1f7a',
  '532a696f',
  '5ac6319f',
  '5d0fd49b',
  '85bedc75',
  '8f970d35',
  '924f5ec9',
  '947c7934',
  '98cd161c',
  'a6fe3aeb',
  'b1e1bd35',
  'b62bfb77',
  'd708940c',
  'e9838029',
  'ef51d258',
  'f6f7a1d9',
  'f887d0be',
  'fd043af6',
  'fe97a788',
];

describe('latency alert de-duplication guard', () => {
  test.each(LATENCY_SERVICES.map(({ id }) => id))(
    '%s latency breach issues are recognized as directly alerted',
    (id) => {
      expect(isInstantPathEvent({
        issueTitle: `LatencyBudgetExceeded: POST /api/${id}/x took 7040ms (budget 3000ms)`,
        errorType: 'LatencyBudgetExceeded',
        culprit: 'processImmediate(node:internal/timers)',
        tags: [],
      })).toBe(true);
    },
  );

  test.each(LATENCY_SERVICES.map(({ id }) => id))(
    '%s uses the shared latency cooldown or is grandfathered',
    (id) => {
      const { source } = LATENCY_SERVICES.find((service) => service.id === id);
      const requiresCooldown = source.includes("require('../latency-alert-cooldown')");

      if (!GRANDFATHERED_WITHOUT_SHARED_COOLDOWN.includes(id)) {
        expect(requiresCooldown).toBe(true);
      }
    },
  );
});
