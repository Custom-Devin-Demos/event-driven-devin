jest.mock('axios', () => ({ create: jest.fn() }));

const axios = require('axios');
const { createVulnerablePR } = require('../app/services/sonar-pr-trigger');

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
    process.env.DEVIN_ORG_ID = 'org-default';
    axios.create.mockReset();
  });

  afterAll(() => {
    delete process.env.GITHUB_PAT;
    delete process.env.DEVIN_ORG_ID;
  });

  test('falls back to the global org when the report carries none', async () => {
    const client = mockGithub();

    await createVulnerablePR({ customer: 'ce9afcfc' });

    expect(dispatchInputs(client).org_id).toBe('org-default');
  });

  test('keeps the org the report supplied', async () => {
    const client = mockGithub();

    await createVulnerablePR({ customer: 'ce9afcfc', devinOrgId: 'org-from-page' });

    expect(dispatchInputs(client).org_id).toBe('org-from-page');
  });

  test('ce9afcfc scans with the default service key', async () => {
    const client = mockGithub();

    await createVulnerablePR({ customer: 'ce9afcfc' });

    expect(dispatchInputs(client).customer).toBe('default');
  });
});
