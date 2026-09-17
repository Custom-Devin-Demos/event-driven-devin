jest.mock('axios', () => ({ create: jest.fn() }));

const axios = require('axios');
const { createVulnerablePR } = require('../app/services/sonar-pr-trigger');
const { getCustomerConfig } = require('../config/customers');

function mockGithub() {
  const post = jest.fn().mockImplementation((url) => {
    if (url.endsWith('/pulls')) {
      return Promise.resolve({
        data: { number: 42, url: 'api-url', html_url: 'html-url' },
      });
    }
    return Promise.resolve({ data: {} });
  });
  const client = {
    get: jest.fn().mockImplementation((url) => {
      if (url.includes('/git/ref/heads/main')) {
        return Promise.resolve({ data: { object: { sha: 'a'.repeat(40) } } });
      }
      return Promise.resolve({ data: { sha: 'blob-sha' } });
    }),
    post,
    put: jest.fn().mockResolvedValue({ data: {} }),
  };
  axios.create.mockReturnValue(client);
  return client;
}

function dispatchInputs(client) {
  const call = client.post.mock.calls.find(([url]) => url.includes('/actions/workflows/'));
  return call[1].inputs;
}

describe('devin-scan workflow dispatch inputs', () => {
  beforeEach(() => {
    process.env.GITHUB_PAT = 'gh-token';
    axios.create.mockReset();
  });

  afterEach(() => {
    delete process.env.DEVIN_ORG_ID;
  });

  afterAll(() => {
    delete process.env.GITHUB_PAT;
  });

  test('ce9afcfc scans with the default service key and the reported org', async () => {
    const client = mockGithub();

    await createVulnerablePR({ customer: 'ce9afcfc', devinOrgId: 'org-from-page' });

    expect(dispatchInputs(client)).toMatchObject({ customer: 'default', org_id: 'org-from-page' });
  });

  test('falls back to the global org when the report carries none', async () => {
    process.env.DEVIN_ORG_ID = 'org-global';
    const client = mockGithub();

    await createVulnerablePR({ customer: 'ce9afcfc' });

    expect(dispatchInputs(client).org_id).toBe('org-global');
  });

  test('ce9afcfc scans the repo the default automations scan', async () => {
    mockGithub();

    await createVulnerablePR({ customer: 'ce9afcfc' });

    expect(getCustomerConfig('ce9afcfc').targetRepo).toBe('COG-GTM/etl-pipeline-demo');
  });
});
