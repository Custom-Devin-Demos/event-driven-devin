#!/usr/bin/env node
/* global fetch */

/**
 * Reconcile stranded Ralph Lauren checkouts after the Meridian Pay incident.
 *
 * Talks to the running app over HTTP only:
 *   1. Pull authorizations created since the incident started.
 *   2. Group them by order reference.
 *   3. Orders still `pending` with >= 1 authorization -> complete with the
 *      first authorization, void the rest.
 *   4. Orders already `paid` -> keep the authorization matching the order's
 *      paymentId, void the rest.
 *
 * Flags: --base-url <url> (default http://localhost:3000)
 *        --since <iso>   (default: metrics.incidentStartedAt, else all)
 *        --dry-run       (print the plan without mutating anything)
 */

function planReconciliation(authorizations, orders) {
  const byReference = new Map();
  for (const auth of authorizations) {
    if (auth.status === 'VOIDED' || auth.voidedAt) continue;
    if (!byReference.has(auth.reference)) byReference.set(auth.reference, []);
    byReference.get(auth.reference).push(auth);
  }

  const plan = { complete: [], void: [], skip: [] };
  for (const [reference, auths] of byReference.entries()) {
    auths.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const order = orders[reference];
    if (!order) {
      plan.skip.push({ reference, reason: 'no matching order' });
      continue;
    }
    if (order.status === 'pending') {
      const [keep, ...rest] = auths;
      plan.complete.push({ orderId: order.id, paymentId: keep.id });
      rest.forEach((a) => plan.void.push({ id: a.id, reference }));
    } else if (order.status === 'paid') {
      const matching = auths.find((a) => a.id === order.paymentId);
      const keep = matching || auths[0];
      auths.filter((a) => a.id !== keep.id)
        .forEach((a) => plan.void.push({ id: a.id, reference }));
    } else {
      plan.skip.push({ reference, reason: `order status ${order.status}` });
    }
  }
  return plan;
}

function parseArgs(argv) {
  const args = { baseUrl: 'http://localhost:3000', since: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base-url') args.baseUrl = argv[++i];
    else if (argv[i] === '--since') args.since = argv[++i];
    else if (argv[i] === '--dry-run') args.dryRun = true;
  }
  return args;
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = args.baseUrl.replace(/\/$/, '');

  let since = args.since;
  if (!since) {
    const metrics = await getJson(`${base}/api/f63013c0/metrics`);
    // Pad the window: the first stranded authorization lands a beat before the
    // first logged failure that sets incidentStartedAt.
    since = metrics.incidentStartedAt
      ? new Date(new Date(metrics.incidentStartedAt).getTime() - 60 * 1000).toISOString()
      : null;
  }

  const query = since ? `?since=${encodeURIComponent(since)}` : '';
  const { authorizations } = await getJson(`${base}/api/f63013c0/psp/v1/authorizations${query}`);
  console.log(`Fetched ${authorizations.length} authorization(s) since ${since || 'the beginning'}.`);

  const references = [...new Set(authorizations.map((a) => a.reference))];
  const orders = {};
  for (const reference of references) {
    try {
      const { order } = await getJson(`${base}/api/f63013c0/orders/${encodeURIComponent(reference)}`);
      if (order) orders[reference] = order;
    } catch {
      // No order for this reference — the planner will skip it.
    }
  }

  const plan = planReconciliation(authorizations, orders);
  console.log(`Plan: ${plan.complete.length} order(s) to complete, ${plan.void.length} authorization(s) to void, ${plan.skip.length} reference(s) skipped.`);

  if (args.dryRun) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  let completed = 0;
  let voided = 0;
  for (const item of plan.complete) {
    const { status } = await postJson(`${base}/api/f63013c0/orders/${encodeURIComponent(item.orderId)}/complete`, { paymentId: item.paymentId });
    if (status === 200) completed += 1;
    else console.log(`  complete ${item.orderId} -> ${status}`);
  }
  for (const item of plan.void) {
    const { status } = await postJson(`${base}/api/f63013c0/psp/v1/payments/${encodeURIComponent(item.id)}/void`);
    if (status === 200) voided += 1;
    else console.log(`  void ${item.id} -> ${status}`);
  }

  const customers = new Set(
    plan.complete.map((c) => (orders[c.orderId] || {}).customerId).filter(Boolean),
  );
  console.log(`Done. Orders completed: ${completed}. Authorizations voided: ${voided}. Customers made whole: ${customers.size}.`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { planReconciliation };
