jest.mock('../app/services/slack', () => ({
  ownerRotation: jest.requireActual('../app/services/slack').ownerRotation,
  postMessage: jest.fn().mockResolvedValue('1700000000.000100'),
  postThreadReply: jest.fn().mockResolvedValue('1700000000.000200'),
  lookupSlackUserByEmail: jest.fn().mockResolvedValue(null),
  findChannelByNameFragment: jest.fn().mockResolvedValue(null),
  joinChannel: jest.fn().mockResolvedValue(undefined),
  postPersonaMessage: jest.fn().mockResolvedValue(undefined),
  inviteToChannel: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../app/services/devin-api', () => ({
  createDevinSession: jest.fn().mockResolvedValue({
    sessionId: 'session-abc',
    url: 'https://app.devin.ai/sessions/session-abc',
  }),
}));

jest.mock('../app/services/sonar-pr-trigger', () => ({
  scheduleVulnerablePR: jest.fn(),
}));

const { postMessage, postThreadReply, lookupSlackUserByEmail } = require('../app/services/slack');
const { scheduleVulnerablePR } = require('../app/services/sonar-pr-trigger');
const { createDevinSession } = require('../app/services/devin-api');
const { getOncallSkin } = require('../config/oncall-skins');

process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0TEST';

const { postOncallAlert, resetSkinAlertMemory } = require('../app/services/oncall');

const AUTO_SKIN_SLUG = '4b663efb';

describe('on-call alerts that auto-create a Devin session', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetSkinAlertMemory();
  });

  test('an opted-in skin creates one session and links it in the alert thread', async () => {
    const skin = getOncallSkin(AUTO_SKIN_SLUG);
    const result = await postOncallAlert(skin.vertical, { skin });

    expect(result.ok).toBe(true);
    expect(createDevinSession).toHaveBeenCalledTimes(1);

    const [prompt] = createDevinSession.mock.calls[0];
    expect(prompt).toContain('POST /api/oncall/marketplace/cart');
    expect(prompt).toContain(`/oncall/c/${skin.slug}`);
    expect(prompt).not.toMatch(/\.js:|at Object\.|app\/services/);

    expect(postThreadReply).toHaveBeenCalledWith(
      'xoxb-test',
      'C0TEST',
      await postMessage.mock.results[0].value,
      expect.stringContaining('https://app.devin.ai/sessions/session-abc'),
      expect.any(Array),
    );
    expect(result.sessionUrl).toBe('https://app.devin.ai/sessions/session-abc');
  });

  test('a skin identity overrides the environment defaults', async () => {
    const skin = {
      ...getOncallSkin(AUTO_SKIN_SLUG),
      devinSession: {
        auto: true,
        orgId: 'org_skin',
        userId: 'user_skin',
        apiKey: 'key_skin',
      },
    };

    await postOncallAlert(skin.vertical, { skin });

    const [, options] = createDevinSession.mock.calls[0];
    expect(options.orgId).toBe('org_skin');
    expect(options.userId).toBe('user_skin');
    expect(options.apiKey).toBe('key_skin');
  });

  test('a skin without an identity falls back to the on-call environment', async () => {
    process.env.DEVIN_ONCALL_ORG_ID = 'org_env';
    process.env.DEVIN_ONCALL_USER_ID = 'user_env';
    process.env.DEVIN_ONCALL_SERVICE_KEY = 'key_env';

    try {
      const skin = getOncallSkin(AUTO_SKIN_SLUG);
      await postOncallAlert(skin.vertical, { skin });

      const [, options] = createDevinSession.mock.calls[0];
      expect(options.orgId).toBe('org_env');
      expect(options.userId).toBe('user_env');
      expect(options.apiKey).toBe('key_env');
    } finally {
      delete process.env.DEVIN_ONCALL_ORG_ID;
      delete process.env.DEVIN_ONCALL_USER_ID;
      delete process.env.DEVIN_ONCALL_SERVICE_KEY;
    }
  });

  test('the triggering user owns the session, ahead of the skin and the env', async () => {
    process.env.DEVIN_ONCALL_USER_ID = 'user_env';

    try {
      const skin = {
        ...getOncallSkin(AUTO_SKIN_SLUG),
        devinSession: { auto: true, orgId: 'org_skin', userId: 'user_skin' },
      };

      await postOncallAlert(skin.vertical, {
        skin,
        devinUserId: 'user_requester',
        devinOrgId: 'org_requester',
      });

      const [, options] = createDevinSession.mock.calls[0];
      expect(options.userId).toBe('user_requester');
      expect(options.orgId).toBe('org_requester');
    } finally {
      delete process.env.DEVIN_ONCALL_USER_ID;
    }
  });

  test('a provider-prefixed requester user id owns the session', async () => {
    const skin = getOncallSkin(AUTO_SKIN_SLUG);

    await postOncallAlert(skin.vertical, {
      skin,
      devinUserId: 'email|69efcc3741b62dd9be352f7c',
      devinOrgId: 'org_69IXJFLrljx8zSAw',
    });

    const [, options] = createDevinSession.mock.calls[0];
    expect(options.userId).toBe('email|69efcc3741b62dd9be352f7c');
    expect(options.orgId).toBe('org_69IXJFLrljx8zSAw');
  });

  test('a malformed requester identity is ignored', async () => {
    const skin = getOncallSkin(AUTO_SKIN_SLUG);

    await postOncallAlert(skin.vertical, {
      skin,
      devinUserId: 'user <!channel>',
      devinOrgId: 'org <!here>',
    });

    const [, options] = createDevinSession.mock.calls[0];
    expect(options.userId).toBeNull();
    expect(options.orgId).toBeUndefined();
  });

  test('a requester org without a user never borrows another source\'s user', async () => {
    process.env.DEVIN_ONCALL_USER_ID = 'user_env';

    try {
      const skin = {
        ...getOncallSkin(AUTO_SKIN_SLUG),
        devinSession: { auto: true, userId: 'user_skin' },
      };

      await postOncallAlert(skin.vertical, { skin, devinOrgId: 'org_requester' });

      const [, options] = createDevinSession.mock.calls[0];
      expect(options.orgId).toBe('org_requester');
      expect(options.userId).toBeNull();
    } finally {
      delete process.env.DEVIN_ONCALL_USER_ID;
    }
  });

  test('a skin org without a user never borrows the environment user', async () => {
    process.env.DEVIN_ONCALL_ORG_ID = 'org_env';
    process.env.DEVIN_ONCALL_USER_ID = 'user_env';

    try {
      const skin = {
        ...getOncallSkin(AUTO_SKIN_SLUG),
        devinSession: { auto: true, orgId: 'org_skin' },
      };

      await postOncallAlert(skin.vertical, { skin });

      const [, options] = createDevinSession.mock.calls[0];
      expect(options.orgId).toBe('org_skin');
      expect(options.userId).toBeNull();
    } finally {
      delete process.env.DEVIN_ONCALL_ORG_ID;
      delete process.env.DEVIN_ONCALL_USER_ID;
    }
  });

  test('a requester user without an org falls back to the configured identity', async () => {
    const skin = {
      ...getOncallSkin(AUTO_SKIN_SLUG),
      devinSession: { auto: true, orgId: 'org_skin', userId: 'user_skin' },
    };

    await postOncallAlert(skin.vertical, { skin, devinUserId: 'user_requester' });

    const [, options] = createDevinSession.mock.calls[0];
    expect(options.orgId).toBe('org_skin');
    expect(options.userId).toBe('user_skin');
  });

  test('a generic alert with no skin stays alert-only', async () => {
    const result = await postOncallAlert('marketplace');

    expect(result.ok).toBe(true);
    expect(result.sessionUrl).toBeUndefined();
    expect(createDevinSession).not.toHaveBeenCalled();
    expect(postThreadReply).not.toHaveBeenCalled();
  });

  test('a skin that did not opt in stays alert-only', async () => {
    const skin = getOncallSkin('63dbb52f');
    expect(skin.devinSession).toBeUndefined();

    const result = await postOncallAlert(skin.vertical, { skin });

    expect(result.ok).toBe(true);
    expect(result.sessionUrl).toBeUndefined();
    expect(createDevinSession).not.toHaveBeenCalled();
    expect(postThreadReply).not.toHaveBeenCalled();
  });

  test('a skin opted into sonarPR queues the remediation demo PR for the requester', async () => {
    const skin = getOncallSkin('ce0199ec');
    expect(skin.sonarPR).toEqual({ auto: true });

    const result = await postOncallAlert(skin.vertical, {
      skin,
      devinUserId: 'user_requester',
      devinOrgId: 'org_requester',
    });

    expect(result.ok).toBe(true);
    expect(result.sonarPR).toBe(true);
    expect(scheduleVulnerablePR).toHaveBeenCalledTimes(1);
    expect(scheduleVulnerablePR).toHaveBeenCalledWith(0, 'default', 'user_requester', 'org_requester');
  });

  test('skins without sonarPR and generic alerts never open the demo PR', async () => {
    await postOncallAlert('marketplace');
    await postOncallAlert('marketplace', { skin: getOncallSkin(AUTO_SKIN_SLUG) });

    expect(scheduleVulnerablePR).not.toHaveBeenCalled();
  });

  test('a failed session creation still leaves the alert posted', async () => {
    createDevinSession.mockRejectedValueOnce(new Error('devin api down'));

    const result = await postOncallAlert('marketplace', { skin: getOncallSkin(AUTO_SKIN_SLUG) });

    expect(result.ok).toBe(true);
    expect(result.sessionUrl).toBeUndefined();
    expect(postThreadReply).not.toHaveBeenCalled();
  });
});

describe('skins that page the triggering presenter as On-Call', () => {
  const TRIGGERER_SKIN_SLUG = '6997dfbe';

  beforeEach(() => {
    jest.clearAllMocks();
    resetSkinAlertMemory();
  });

  test('the presenter owns the session and is paged as On-Call', async () => {
    lookupSlackUserByEmail.mockResolvedValueOnce('U0PRESENTER');
    const skin = getOncallSkin(TRIGGERER_SKIN_SLUG);

    const result = await postOncallAlert(skin.vertical, {
      skin,
      devinEmail: 'presenter@devindemos.com',
      devinUserId: 'user_presenter',
      devinOrgId: 'org_presenter',
    });

    expect(result.ok).toBe(true);
    const [, , text, blocks] = postMessage.mock.calls[0];
    expect(text).toContain('*On-Call:* <@U0PRESENTER>');
    expect(text).not.toContain('*Owner:*');
    expect(text).not.toContain('Triggered by');
    expect(JSON.stringify(blocks)).not.toContain('Triggered by');
    expect(JSON.stringify(blocks)).toContain('On-Call');
    expect(JSON.stringify(blocks)).toContain('<@U0PRESENTER>');

    const [prompt, options] = createDevinSession.mock.calls[0];
    expect(options.userId).toBe('user_presenter');
    expect(options.orgId).toBe('org_presenter');
    expect(prompt).toContain('<@U0PRESENTER>');
  });

  test('an unresolvable presenter keeps the owner rotation and no mention', async () => {
    const skin = getOncallSkin(TRIGGERER_SKIN_SLUG);

    const result = await postOncallAlert(skin.vertical, { skin, devinEmail: 'nobody@devindemos.com' });

    expect(result.ok).toBe(true);
    const [, , text] = postMessage.mock.calls[0];
    expect(text).toContain('*Owner:*');
    expect(text).not.toContain('*On-Call:*');
    const [prompt] = createDevinSession.mock.calls[0];
    expect(prompt).not.toMatch(/<@[A-Z0-9]+>/);
  });

  test('skins without the flag never page the presenter as On-Call', async () => {
    lookupSlackUserByEmail.mockResolvedValueOnce('U0PRESENTER');
    const skin = getOncallSkin(AUTO_SKIN_SLUG);

    await postOncallAlert(skin.vertical, { skin, devinEmail: 'presenter@devindemos.com' });

    const [, , text] = postMessage.mock.calls[0];
    expect(text).not.toContain('*On-Call:*');
  });
});

describe('Coppel On-Call skin (Spanish, presenter paged)', () => {
  const COPPEL_SLUG = '04eac4a1';

  beforeEach(() => {
    jest.clearAllMocks();
    resetSkinAlertMemory();
  });

  test('the presenter owns the session, is paged as On Call and is not repeated as "Activado por"', async () => {
    lookupSlackUserByEmail.mockResolvedValueOnce('U0PRESENTER');
    const skin = getOncallSkin(COPPEL_SLUG);

    const result = await postOncallAlert(skin.vertical, {
      skin,
      devinEmail: 'presenter@devindemos.com',
      devinUserId: 'user_presenter',
      devinOrgId: 'org_presenter',
    });

    expect(result.ok).toBe(true);
    const [, , text, blocks] = postMessage.mock.calls[0];
    const blocksJson = JSON.stringify(blocks);
    expect(text).toContain('*[Activada] Latencia p95 disparada');
    expect(text).toContain('*On Call:* <@U0PRESENTER>');
    expect(text).toContain('*Servicio:* pedidos-api (Coppel)');
    expect(text).toContain('*Página afectada:*');
    expect(blocksJson).toContain('Ver en Datadog');
    for (const forbidden of ['Triggered by', 'Activado por', '*Responsable:*', '*On-Call:*', '*Owner:*']) {
      expect(text).not.toContain(forbidden);
    }
    expect(blocksJson).not.toMatch(/Triggered by|Activado por/);

    const [prompt, options] = createDevinSession.mock.calls[0];
    expect(options.userId).toBe('user_presenter');
    expect(options.orgId).toBe('org_presenter');
    expect(options.title).toMatch(/^\[On Call\] /);
    expect(prompt).toContain('Un monitor de Datadog está disparando en pedidos-api');
    expect(prompt).toContain('/oncall/c/04eac4a1');
    expect(prompt).toContain('POST /api/oncall/clickcollect/checkout');
    expect(prompt).toContain('<@U0PRESENTER>');
    expect(prompt).toContain('responde en español');
    expect(prompt).toContain('Recoger en tienda');

    const [, , , replyText, replyBlocks] = postThreadReply.mock.calls.find((c) => /Devin está investigando/.test(c[3]));
    expect(replyText).toContain('https://app.devin.ai/sessions/session-abc');
    expect(JSON.stringify(replyBlocks)).toContain('Ver sesión');
  });

  test('an unresolvable presenter falls back to the Responsable rotation in Spanish', async () => {
    const skin = getOncallSkin(COPPEL_SLUG);

    await postOncallAlert(skin.vertical, { skin, devinEmail: 'nobody@devindemos.com' });

    const [, , text] = postMessage.mock.calls[0];
    expect(text).toContain('*Responsable:*');
    expect(text).toContain('omnicanal-oncall');
    expect(text).not.toContain('*On Call:*');
  });

  test('English skins keep their English card', async () => {
    const skin = getOncallSkin(AUTO_SKIN_SLUG);

    await postOncallAlert(skin.vertical, { skin });

    const [, , text] = postMessage.mock.calls[0];
    expect(text).toContain('*Service:*');
    expect(text).not.toContain('*Servicio:*');
  });
});

describe('Copa Airlines On-Call skin (fixed On-Call member, Slack only)', () => {
  const COPA_SLUG = '90bf6ab8';
  const ENV_KEY = 'CUSTOMER_90BF6AB8_SLACK_MEMBER_ID';

  beforeEach(() => {
    jest.clearAllMocks();
    resetSkinAlertMemory();
    delete process.env[ENV_KEY];
  });

  afterAll(() => {
    delete process.env[ENV_KEY];
  });

  test('routes to Slack, pages the configured member as On-Call and names Copa Airlines', async () => {
    const skin = getOncallSkin(COPA_SLUG);
    expect(skin.alertDestination).toBe('slack');
    expect(skin.teamsAlerts).toBeUndefined();

    const result = await postOncallAlert(skin.vertical, { skin });

    expect(result.ok).toBe(true);
    const [, , text, blocks] = postMessage.mock.calls[0];
    expect(text).toContain(`*On-Call:* <@${skin.onCallSlackMemberId}>`);
    expect(text).toContain('Copa Airlines');
    expect(text).toContain('Pagar reserva');
    expect(text).not.toContain('*Owner:*');
    expect(JSON.stringify(blocks)).toContain(`<@${skin.onCallSlackMemberId}>`);

    expect(createDevinSession).toHaveBeenCalledTimes(1);
    const [prompt] = createDevinSession.mock.calls[0];
    expect(prompt).toContain('/oncall/c/90bf6ab8');
    expect(prompt).toContain('POST /api/oncall/banking/transfer');
    expect(prompt).toContain(`<@${skin.onCallSlackMemberId}>`);
  });

  test('CUSTOMER_<SLUG>_SLACK_MEMBER_ID overrides the configured member', async () => {
    process.env[ENV_KEY] = 'U0OVERRIDE';
    const skin = getOncallSkin(COPA_SLUG);

    await postOncallAlert(skin.vertical, { skin });

    const [, , text] = postMessage.mock.calls[0];
    expect(text).toContain('*On-Call:* <@U0OVERRIDE>');
    expect(text).not.toContain(skin.onCallSlackMemberId);
    const [prompt] = createDevinSession.mock.calls[0];
    expect(prompt).toContain('<@U0OVERRIDE>');
  });

  test('a malformed override is ignored', async () => {
    process.env[ENV_KEY] = 'jaime@cognition.ai';
    const skin = getOncallSkin(COPA_SLUG);

    await postOncallAlert(skin.vertical, { skin });

    const [, , text] = postMessage.mock.calls[0];
    expect(text).toContain(`*On-Call:* <@${skin.onCallSlackMemberId}>`);
  });

  test('the presenter who triggered it is still credited', async () => {
    lookupSlackUserByEmail.mockResolvedValueOnce('U0PRESENTER');
    const skin = getOncallSkin(COPA_SLUG);

    await postOncallAlert(skin.vertical, { skin, devinEmail: 'presenter@devindemos.com' });

    const [, , text] = postMessage.mock.calls[0];
    expect(text).toContain(`*On-Call:* <@${skin.onCallSlackMemberId}>`);
    expect(text).toContain('<@U0PRESENTER>');
  });
});

describe('B3 On-Call skin (fixed On-Call member, Slack only)', () => {
  const B3_SLUG = '407cff9e';
  const ENV_KEY = 'CUSTOMER_407CFF9E_SLACK_MEMBER_ID';

  beforeEach(() => {
    jest.clearAllMocks();
    resetSkinAlertMemory();
    delete process.env[ENV_KEY];
  });

  afterAll(() => {
    delete process.env[ENV_KEY];
  });

  test('routes to Slack, pages the configured member as On-Call and names B3', async () => {
    const skin = getOncallSkin(B3_SLUG);
    expect(skin.alertDestination).toBe('slack');
    expect(skin.teamsAlerts).toBeUndefined();
    expect(skin.onCallSlackMemberId).toBe('U09A56TAB8B');
    expect(skin.alertCard.metricQuery).toContain('service:checkout-api');

    const result = await postOncallAlert(skin.vertical, { skin });

    expect(result.ok).toBe(true);
    const [, , text, blocks] = postMessage.mock.calls[0];
    expect(text).toContain('*On-Call:* <@U09A56TAB8B>');
    expect(text).toContain('B3');
    expect(text).toContain('Confirmar investimento');
    expect(text).toContain('investidor-tesouro-custodia');
    expect(JSON.stringify(blocks)).toContain('<@U09A56TAB8B>');

    expect(createDevinSession).toHaveBeenCalledTimes(1);
    const [prompt] = createDevinSession.mock.calls[0];
    expect(prompt).toContain('/oncall/c/407cff9e');
    expect(prompt).toContain('POST /api/oncall/banking/transfer');
    expect(prompt).toContain('<@U09A56TAB8B>');
  });

  test('CUSTOMER_407CFF9E_SLACK_MEMBER_ID overrides the configured member', async () => {
    process.env[ENV_KEY] = 'U0OVERRIDE';
    const skin = getOncallSkin(B3_SLUG);

    await postOncallAlert(skin.vertical, { skin });

    const [, , text] = postMessage.mock.calls[0];
    expect(text).toContain('*On-Call:* <@U0OVERRIDE>');
    expect(text).not.toContain(skin.onCallSlackMemberId);
  });
});

describe('per-skin repository override for auto sessions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetSkinAlertMemory();
  });

  test('scopes the session to the override repo and links it on the alert card', async () => {
    const skin = getOncallSkin('11a84bb4');
    const result = await postOncallAlert(skin.vertical, { skin });

    expect(result.ok).toBe(true);
    const [prompt, options] = createDevinSession.mock.calls[0];
    expect(options.repos).toEqual(['COG-GTM/SampleMvcWebApp']);
    expect(prompt).toContain('https://github.com/COG-GTM/SampleMvcWebApp/tree/assessment-delivery-demo');
    expect(prompt).not.toContain('https://github.com/COG-GTM/event-driven-devin');

    const [, , text, blocks] = postMessage.mock.calls[0];
    expect(text).toContain('Repo: https://github.com/COG-GTM/SampleMvcWebApp/tree/assessment-delivery-demo');
    expect(JSON.stringify(blocks)).toContain('Repo: https://github.com/COG-GTM/SampleMvcWebApp/tree/assessment-delivery-demo');
    expect(JSON.stringify(blocks)).not.toContain('event-driven-devin');
  });

  test('skins without the override keep the default repo and pass no repos', async () => {
    const skin = getOncallSkin(AUTO_SKIN_SLUG);
    await postOncallAlert(skin.vertical, { skin });

    const [prompt, options] = createDevinSession.mock.calls[0];
    expect(options).not.toHaveProperty('repos');
    expect(prompt).toContain('https://github.com/COG-GTM/event-driven-devin');
    const [, , text] = postMessage.mock.calls[0];
    expect(text).toContain('Repo: https://github.com/COG-GTM/event-driven-devin');
  });
});
