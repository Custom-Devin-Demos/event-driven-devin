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

  afterAll(() => {
    delete process.env.GITHUB_PAT;
  });

  test('a default-key scan leaves the org to the target repo secret', async () => {
    const client = mockGithub();

    await createVulnerablePR({ customer: 'ce9afcfc', devinOrgId: 'org-from-page' });

    expect(dispatchInputs(client)).toMatchObject({ customer: 'default', org_id: '' });
  });

  test('a customer-key scan keeps the org the report supplied', async () => {
    const client = mockGithub();

    await createVulnerablePR({ customer: '5b992ae7', devinOrgId: 'org-from-page' });

    expect(dispatchInputs(client)).toMatchObject({ customer: '5b992ae7', org_id: 'org-from-page' });
  });

  test('ce9afcfc scans the repo the default automations scan', async () => {
    mockGithub();

    await createVulnerablePR({ customer: 'ce9afcfc' });

    expect(getCustomerConfig('ce9afcfc').targetRepo).toBe('COG-GTM/etl-pipeline-demo');
  });
});
