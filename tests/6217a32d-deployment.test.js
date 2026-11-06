/* global describe, test, expect */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');

describe('6217a32d deployed asset and embedding contracts', () => {
  test('script and stylesheet URLs include their current content digest', () => {
    const html = fs.readFileSync(path.join(root, 'app/public/verticals/6217a32d.html'), 'utf8');
    for (const name of ['emulator.js', 'emulator.css', 'tv-bridge.js']) {
      const asset = '/verticals/assets/6217a32d/' + name;
      const content = fs.readFileSync(path.join(root, 'app/public', asset));
      const digest = crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
      expect(html).toContain(`${asset}?v=${digest}"`);
      expect(html).not.toContain(`${asset}"`);
    }
  });

  test('only the TV skin and its aliases permit same-origin framing at ingress', () => {
    const conf = fs.readFileSync(path.join(root, 'nginx/nginx.conf'), 'utf8');
    const block = conf.match(/map \$uri \$frame_options \{([^}]+)\}/);
    expect(block).not.toBeNull();
    const entries = Object.fromEntries([...block[1].matchAll(/(\S+)\s+(\S+);/g)].map((match) => [match[1], match[2]]));
    expect(entries).toEqual({
      default: 'DENY',
      '/oncall/c/6217a32d': 'SAMEORIGIN',
      '/oncall/c/6217a32d/': 'SAMEORIGIN',
      '/6217a32d': 'SAMEORIGIN',
      '/6217a32d/': 'SAMEORIGIN',
      '/streamtv': 'SAMEORIGIN',
      '/streamtv/': 'SAMEORIGIN',
    });
    expect(conf).toContain('add_header X-Frame-Options $frame_options always;');
    expect(conf).toContain('add_header X-Content-Type-Options nosniff always;');
    expect(conf).toContain('add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;');
  });
});
