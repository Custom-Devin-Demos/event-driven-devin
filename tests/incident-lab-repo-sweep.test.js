const { createRepoSweepSink, repoFromUrl } = require('../app/services/incident-lab/repo-sweep');

function makeRun() {
  return {
    runRef: 'LAB-TEST-00001',
    scenario: { repoUrl: 'https://github.com/acme-demo/n8n' },
  };
}

describe('incident-lab repo sweep', () => {
  const savedToken = { lab: process.env.INCIDENT_LAB_GITHUB_TOKEN, gh: process.env.GITHUB_TOKEN };
  let request;

  beforeEach(() => {
    process.env.INCIDENT_LAB_GITHUB_TOKEN = 'test-token';
    delete process.env.GITHUB_TOKEN;
    request = {
      get: jest.fn(),
      patch: jest.fn().mockResolvedValue({ data: {} }),
      delete: jest.fn().mockResolvedValue({ data: {} }),
    };
  });

  afterEach(() => {
    if (savedToken.lab === undefined) delete process.env.INCIDENT_LAB_GITHUB_TOKEN;
    else process.env.INCIDENT_LAB_GITHUB_TOKEN = savedToken.lab;
    if (savedToken.gh === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedToken.gh;
  });

  test('parses owner/repo from the scenario repo url', () => {
    expect(repoFromUrl('https://github.com/acme-demo/n8n')).toEqual({ owner: 'acme-demo', repo: 'n8n' });
    expect(repoFromUrl('https://github.com/acme-demo/n8n.git')).toEqual({ owner: 'acme-demo', repo: 'n8n' });
    expect(repoFromUrl('https://example.com/not-github')).toBeNull();
    expect(repoFromUrl('https://elsewhere.example/github.com/acme-demo/n8n')).toBeNull();
  });

  test('closes devin/* fix PRs and deletes devin/* branches, nothing else', async () => {
    request.get.mockImplementation((url) => {
      if (url.includes('/pulls')) {
        return Promise.resolve({ data: [
          { number: 7, head: { ref: 'devin/123-fix-offload', repo: { full_name: 'acme-demo/n8n' } } },
          { number: 8, head: { ref: 'feature/unrelated', repo: { full_name: 'acme-demo/n8n' } } },
          { number: 9, head: { ref: 'devin/789-contributor', repo: { full_name: 'outsider/n8n' } } },
        ] });
      }
      return Promise.resolve({ data: [
        { name: 'master' },
        { name: 'flowforge-prod' },
        { name: 'devin/123-fix-offload' },
        { name: 'devin/456-other-fix' },
      ] });
    });
    const sink = createRepoSweepSink({ request });

    await sink.onStop(makeRun());

    expect(request.patch).toHaveBeenCalledTimes(1);
    expect(request.patch.mock.calls[0][0]).toContain('/pulls/7');
    expect(request.patch.mock.calls[0][1]).toEqual({ state: 'closed' });
    const deleted = request.delete.mock.calls.map(([url]) => url);
    expect(deleted).toHaveLength(2);
    for (const url of deleted) {
      expect(url).toMatch(/\/git\/refs\/heads\/devin%2F/);
    }
  });

  test('sweeps at arm too, so a run that is never stopped leaves no residue', async () => {
    request.get.mockResolvedValue({ data: [{ name: 'devin/123-fix-offload' }] });
    const sink = createRepoSweepSink({ request });

    await sink.onArm(makeRun());

    expect(request.delete).toHaveBeenCalledTimes(1);
  });

  test('follows pagination past the first page of branches', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ name: `devin/branch-${i}` }));
    request.get.mockImplementation((url) => {
      if (url.includes('/pulls')) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: url.endsWith('page=1') ? page1 : [{ name: 'devin/branch-100' }] });
    });
    const sink = createRepoSweepSink({ request });

    await sink.onStop(makeRun());

    expect(request.delete).toHaveBeenCalledTimes(101);
  });

  test('does nothing without a token', async () => {
    delete process.env.INCIDENT_LAB_GITHUB_TOKEN;
    const sink = createRepoSweepSink({ request });

    await sink.onStop(makeRun());

    expect(request.get).not.toHaveBeenCalled();
  });

  test('a failed branch deletion does not stop the rest of the sweep', async () => {
    request.get.mockImplementation((url) => {
      if (url.includes('/pulls')) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [
        { name: 'devin/first' },
        { name: 'devin/second' },
      ] });
    });
    request.delete
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ data: {} });
    const sink = createRepoSweepSink({ request });

    await expect(sink.onStop(makeRun())).resolves.toBeUndefined();
    expect(request.delete).toHaveBeenCalledTimes(2);
  });
});
