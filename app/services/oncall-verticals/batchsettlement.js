const crypto = require('crypto');
const axios = require('axios');
const logger = require('../../telemetry/logger');
const jobs = require('./batchsettlement-jobs.json');
const { SLUG, simulatedPrompt } = require('../../../config/regions-batch');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PD_ID = /^[A-Z0-9]{6,32}$/;

function createBatchSettlement({ http = axios, postAlert, getSkin, env = process.env, now = Date.now } = {}) {
  const services = [
    ['MFT', env.BATCH_PD_MFT_SERVICE_ID || 'PU8BL8X', 'RGW-MFTSQL-07', 'Axway inbound settlement SLA missed: TLS handshake failure; no landing file', 'BATCH_PD_ROUTING_KEY_MFT'],
    ['SQL', 'PQZQKW7', 'RGW-MFTSQL-07', 'EDW settlement load failed: SSL Provider handshake failure; login timeout', 'BATCH_PD_ROUTING_KEY_SQL'],
    ['MAINFRAME', 'PN02JGH', 'RGP1-JES2', 'SETLPOST blocked: RG.SETTLE.D261115.INPUT not cataloged; GL posting held', 'BATCH_PD_ROUTING_KEY_MF'],
  ];
  const delayValue = Number(env.BATCH_PD_DELAY_SECONDS ?? 30);
  const delay = Number.isFinite(delayValue) && delayValue >= 0 && delayValue <= 3600 ? delayValue : 30;
  const simulated = services.some((s) => !/^[A-Za-z0-9]{32}$/.test(env[s[4]] || ''));
  const dryRun = !simulated && env.BATCH_PD_DRY_RUN === '1';
  const serviceNames = ['Axway MFT Gateway', 'EDW SQL Load', 'Mainframe Batch zOS'];
  let incidentNumber = 1000;
  let scope = now();
  let generation = 0;
  let current = null;
  let cache = null;
  let fetching = null;
  const runs = new Map();
  const dispatched = new Map();

  const headers = () => ({ Authorization: `Token token=${env.BATCH_PD_API_TOKEN}`, Accept: 'application/vnd.pagerduty+json;version=2' });
  async function pdGet(path, params) {
    if (!env.BATCH_PD_API_TOKEN) throw new Error('PagerDuty token not configured');
    const { data } = await http.get(`https://api.pagerduty.com${path}`, { headers: headers(), params, timeout: 15000 });
    return data;
  }
  async function paginate(path, field, params = {}) {
    const items = [];
    for (let offset = 0; offset < 10000; offset += 100) {
      const data = await pdGet(path, { ...params, limit: 100, offset });
      items.push(...(data[field] || []));
      if (!data.more) return items;
    }
    throw new Error('PagerDuty pagination limit exceeded');
  }

  function eventPayload(run, index) {
    const [component, serviceId, source, summary, key] = services[index];
    return {
      routing_key: env[key], event_action: 'trigger', dedup_key: `settlement-${run.run_id}-${component.toLowerCase()}`,
      payload: { summary, source, severity: 'critical', component, group: 'Enterprise Batch Operations', class: 'overnight-settlement',
        custom_details: { run_id: run.run_id, service_id: serviceId, business_date: '2026-11-15', chain: 'overnight-settlement',
          change: 'CHG0091842', evidence: 'logs/2026-11-15', profile: 'config/shared-tls-profile.json' } },
    };
  }

  function sendNext(run, index) {
    if (run.cancelled) return;
    const component = services[index][0];
    const event = eventPayload(run, index);
    if (simulated) {
      const incident = { ...run.planned_incidents[index], created_at: new Date(now()).toISOString() };
      run.incidents.push(incident);
      if (index === 0) dispatch(run, incident).then((result) => {
        if (result.status !== 200) run.dispatch_error = 'Slack/Devin dispatch unavailable; start a new run to retry';
      });
    }
    const delivery = simulated ? Promise.resolve() : dryRun ? Promise.resolve().then(() => logger.info('Batch settlement dry run', { component }))
      : http.post('https://events.pagerduty.com/v2/enqueue', event, { timeout: 15000 }).then((response) => {
        if (response.status !== 202 || response.data.status !== 'success') throw new Error('Event rejected');
      });
    delivery.then(() => {
      if (run.cancelled) return;
      run.sent.push(component);
      if (index === services.length - 1) run.status = 'complete';
      else {
        run.timer = setTimeout(() => sendNext(run, index + 1), delay * 1000);
        run.timer.unref?.();
      }
    }).catch(() => {
      run.status = 'error';
      logger.error('Batch settlement event dispatch failed');
    });
  }

  function start(body = {}) {
    if (body.skin !== SLUG) return { status: 400, body: { error: 'Unknown batch settlement skin' } };
    if (current?.status === 'active') return { status: 409, body: { error: 'A run is already active' } };
    if (runs.size >= 1000) return { status: 429, body: { error: 'Reset local state before starting more runs' } };
    const presenter = {};
    for (const key of ['devinUserId', 'devinOrgId', 'devinEmail']) {
      if (body[key] !== undefined && (typeof body[key] !== 'string' || body[key].length > 254)) {
        return { status: 400, body: { error: 'Invalid presenter identity' } };
      }
      presenter[key] = body[key] || '';
    }
    current = { run_id: crypto.randomUUID(), presenter, created_at: new Date(now()).toISOString(), status: 'active', sent: [] };
    if (simulated) {
      current.incidents = [];
      current.planned_incidents = services.map((s, index) => ({
        id: `P${crypto.randomBytes(3).toString('hex').toUpperCase()}`, incident_number: ++incidentNumber,
        title: s[3], summary: s[3], source: s[2], component: s[0], status: 'triggered',
        created_at: new Date(now() + index * delay * 1000).toISOString(),
        service: { id: s[1], name: serviceNames[index] }, notes: [],
        custom_details: eventPayload(current, index).payload.custom_details,
      }));
    }
    runs.set(current.run_id, current);
    sendNext(current, 0);
    return { status: 202, body: { run_id: current.run_id, dry_run: dryRun, simulated } };
  }

  async function webhook(body) {
    if (simulated) return { status: 202, body: { ignored: true, reason: 'In-app PagerDuty mode' } };
    const event = body?.event;
    const incident = event?.data;
    if (event?.event_type !== 'incident.triggered' || incident?.service?.id !== services[0][1]) {
      return { status: 202, body: { ignored: true } };
    }
    if (!PD_ID.test(incident.id || '')) return { status: 400, body: { error: 'Invalid incident id' } };
    const startedGeneration = generation;
    let runId = incident.custom_details?.run_id || incident.body?.details?.run_id || event.run_id || body.run_id;
    if (!runId) {
      const data = await pdGet(`/incidents/${incident.id}/alerts`, { limit: 1, offset: 0 });
      runId = data.alerts?.[0]?.body?.details?.run_id;
    }
    const run = typeof runId === 'string' && UUID.test(runId) ? runs.get(runId) : null;
    if (!run || startedGeneration !== generation) return { status: 202, body: { ignored: true, reason: 'Unknown or reset run' } };
    return dispatch(run, incident);
  }

  async function dispatch(run, incident) {
    const runId = run.run_id;
    const startedGeneration = generation;
    if (dispatched.has(runId)) return { status: 200, body: { duplicate: true } };
    dispatched.set(runId, 'pending');
    try {
      const skin = getSkin(SLUG);
      const baseUrl = (env.ONCALL_DEMO_BASE_URL || `https://${env.DOMAIN_NAME || 'devindemos.com'}`).replace(/\/$/, '');
      const incidentUrl = simulated ? `${baseUrl}/oncall/c/${SLUG}#incident-${incident.id}`
        : `https://humza-cog.pagerduty.com/incidents/${incident.id}`;
      const title = `[PagerDuty] Triggered #${incident.incident_number || incident.id}: Axway MFT Gateway — Inbound settlement file not received by SLA (TLS handshake failure)`;
      const result = await postAlert('batchsettlement', {
        skin: { ...skin, devinSession: { ...skin.devinSession,
          promptAppendix: `${simulated ? simulatedPrompt(run.planned_incidents) : skin.devinSession.promptAppendix}\nTriggered by PagerDuty: ${incidentUrl}\nMFT service: ${services[0][1]} (use this configured service ID instead of the default MFT service for this run).` },
        alertCard: { ...skin.alertCard, title, pagerduty: { incidentUrl, number: incident.incident_number || incident.id, service: serviceNames[0] },
          endpointLabel: `Triggered by PagerDuty: ${incidentUrl}`,
          symptom: `${skin.alertCard.symptom} Triggered by PagerDuty: ${incidentUrl}` } },
        ...run.presenter, destination: 'slack', unique: true, runRef: runId,
      });
      if (!result.ok || !result.sessionUrl) throw new Error('Alert or session unavailable');
      run.session_url = result.sessionUrl;
      run.incident_url = incidentUrl;
      run.session_started_at = new Date(now()).toISOString();
      if (/^[A-Z0-9]+$/.test(result.channel || '') && /^\d+\.\d+$/.test(result.ts || '')) {
        run.slack_thread_url = `https://app.slack.com/archives/${result.channel}/p${result.ts.replace('.', '')}`;
      }
      if (generation === startedGeneration) dispatched.set(runId, 'complete');
      logger.info('Batch settlement on-call dispatched', { run_id: runId });
      return { status: 200, body: { ok: true, sessionUrl: result.sessionUrl } };
    } catch {
      dispatched.delete(runId);
      logger.error('Batch settlement on-call dispatch failed');
      return { status: 503, body: { error: 'On-call dispatch unavailable; retry delivery' } };
    }
  }

  async function state() {
    const startedGeneration = generation;
    if (!simulated && (!cache || cache.expires <= now())) {
      if (!fetching) {
        const fetchState = async () => {
          const incidents = env.BATCH_PD_API_TOKEN ? await paginate('/incidents', 'incidents', {
            'service_ids[]': services.map((s) => s[1]), 'statuses[]': ['triggered', 'acknowledged'], since: new Date(scope).toISOString(),
          }) : [];
          const scoped = incidents.filter((i) => i.status !== 'resolved' && Date.parse(i.created_at) > scope && services.some((s) => s[1] === i.service?.id));
          const result = await Promise.all(scoped.map(async (i) => ({
            id: i.id, title: i.title, status: i.status, created_at: i.created_at,
            service: { id: i.service.id, name: i.service.summary || '' },
            notes: (await paginate(`/incidents/${encodeURIComponent(i.id)}/notes`, 'notes')).map((n) => ({
              id: n.id, content: n.content || '', created_at: n.created_at, author: n.user?.summary || 'Operator',
            })),
          })));
          if (generation === startedGeneration) cache = { incidents: result, expires: now() + 5000, fetched_at: new Date(now()).toISOString() };
        };
        fetching = fetchState().finally(() => { if (generation === startedGeneration) fetching = null; });
      }
      await fetching;
    }
    const run = current ? { run_id: current.run_id, created_at: current.created_at, status: current.status,
      sent: [...current.sent], session_url: current.session_url || null, incident_url: current.incident_url || null,
      slack_thread_url: current.slack_thread_url || null, dispatch_error: current.dispatch_error || null } : null;
    const activity = simulated ? [...runs.values()].filter((r) => r.session_url).map((r) => ({
      id: `session-${r.run_id}`, created_at: r.session_started_at, author: 'PagerDuty', service: 'Axway MFT Gateway',
      content: 'Devin session started', session_url: r.session_url, slack_thread_url: r.slack_thread_url || null,
    })) : [];
    return { incidents: simulated ? [...runs.values()].flatMap((r) => r.incidents).filter((i) => i.status !== 'resolved') : cache?.incidents || [],
      activity, fetched_at: simulated ? new Date(now()).toISOString() : cache?.fetched_at || new Date(now()).toISOString(),
      jobs, run, simulated, dry_run: dryRun, delay_seconds: delay, scope_started_at: new Date(scope).toISOString(),
      service_jobs: { [services[0][1]]: ['MFT_INBOUND'], PQZQKW7: ['SQL_STAGE', 'EDW_LOAD'], PN02JGH: ['SETTLE_POST'] },
      ...(current?.dispatch_error ? { warning: current.dispatch_error } : !simulated && !env.BATCH_PD_API_TOKEN
        ? { warning: 'PagerDuty API token not configured; incident polling disabled' } : {}) };
  }

  function reset() {
    for (const run of runs.values()) { run.cancelled = true; clearTimeout(run.timer); }
    runs.clear();
    dispatched.clear();
    current = null;
    scope = now();
    generation += 1;
    cache = null;
    fetching = null;
    return { reset: true, message: 'Local state cleared; PagerDuty unchanged' };
  }

  return { start, webhook, state, reset };
}

module.exports = { createBatchSettlement };
