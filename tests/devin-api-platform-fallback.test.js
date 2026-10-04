jest.mock('axios');

const axios = require('axios');
const { createDevinSession } = require('../app/services/devin-api');

describe('createDevinSession platform placement', () => {
  const session = { data: { session_id: 'devin-abc', url: 'https://app.devin.ai/sessions/abc' } };

  beforeEach(() => {
    axios.post.mockReset();
  });

  test('sends the requested platform label to the v3 sessions API', async () => {
    axios.post.mockResolvedValue(session);

    const result = await createDevinSession('prompt', {
      apiKey: 'key',
      orgId: 'org_test',
      userId: 'user-1',
      platform: 'macos',
    });

    expect(result).toEqual({ sessionId: 'devin-abc', url: 'https://app.devin.ai/sessions/abc' });
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.post.mock.calls[0][1]).toEqual({
      prompt: 'prompt',
      create_as_user_id: 'user-1',
      platform: 'macos',
    });
  });

  test('retries on the org default placement when the platform label is rejected', async () => {
    const rejection = new Error('Request failed with status code 400');
    rejection.response = { status: 400, data: { detail: 'Unknown platform. Available: macOS, windows' } };
    axios.post.mockRejectedValueOnce(rejection).mockResolvedValueOnce(session);

    const result = await createDevinSession('prompt', {
      apiKey: 'key',
      orgId: 'org_test',
      platform: 'macos',
    });

    expect(result).toEqual({ sessionId: 'devin-abc', url: 'https://app.devin.ai/sessions/abc' });
    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(axios.post.mock.calls[0][1]).toHaveProperty('platform', 'macos');
    expect(axios.post.mock.calls[1][1]).toEqual({ prompt: 'prompt' });
  });

  test('does not retry an unrelated 400 even when a platform was requested', async () => {
    const rejection = new Error('Request failed with status code 400');
    rejection.response = { status: 400, data: { detail: 'create_as_user_id: user not found in organization' } };
    axios.post.mockRejectedValueOnce(rejection);

    const result = await createDevinSession('prompt', {
      apiKey: 'key',
      orgId: 'org_test',
      userId: 'user-missing',
      platform: 'macos',
    });

    expect(result).toBeNull();
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  test('does not retry when no platform was requested', async () => {
    const rejection = new Error('Request failed with status code 400');
    rejection.response = { status: 400, data: { detail: 'bad prompt' } };
    axios.post.mockRejectedValueOnce(rejection);

    const result = await createDevinSession('prompt', { apiKey: 'key', orgId: 'org_test' });

    expect(result).toBeNull();
    expect(axios.post).toHaveBeenCalledTimes(1);
  });
});
