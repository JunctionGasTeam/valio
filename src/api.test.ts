// Gateway + policy (context.md §13.4, §13.5). Needs data/valio.db with the recorded milk offers for 2026-11-16.
import { test, mock, after } from 'node:test';
import { rmSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.ts';
import { createApp, seed } from './api.ts';
import { evaluate, effectivePolicy, PolicySchema } from './policy.ts';

process.env.DEMO_NOW = '2026-11-14T12:00:00+0200';
const tmp = join(tmpdir(), `tta-test-${process.pid}.db`);
openDb().exec(`VACUUM INTO '${tmp}'`);
// Catalogue + recorded offers from the real DB, but none of its demo state (proposals, decision record, saved policy).
const fresh = openDb(tmp);
fresh.exec(`DROP TABLE audit; DROP TABLE proposals; DROP TABLE tokens; DROP TABLE users; DROP TABLE customers;`);
fresh.close();
const db = openDb(tmp);
seed(db);
const app = createApp(db);
after(() => { db.close(); for (const s of ['', '-wal', '-shm']) rmSync(tmp + s, { force: true }); });

// "Live" API = snapshot of the recorded cache; `bump` changes one price to simulate a change before approval.
const snap = new Map((db.prepare('SELECT endpoint, product, date, response FROM offer_cache').all() as any[])
  .map((r) => [`${r.endpoint}|${r.product}|${r.date}`, r.response as string]));
let bump: string | null = null;
mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
  const { products, requestedDate } = JSON.parse(init.body as string);
  const ep = url.endsWith('/price') ? 'price' : 'availability';
  return Response.json({
    products: products.map((id: string) => {
      // Asked for Sunday 15 Nov, Valio answers with what it has for Monday (availableDate 16 Nov): a late offer (E3).
      const date = requestedDate === '2026-11-15' ? '2026-11-16' : requestedDate;
      const r = JSON.parse(snap.get(`${ep}|${id}|${date}`) ?? (ep === 'price'
        ? JSON.stringify({ productId: id, quantity: 1, error: true, netPriceFound: false })
        : JSON.stringify({ productId: id, salesBlock: false, scheduleLines: [] })));
      if (ep === 'price' && id === bump && r.catalogPrice) r.catalogPrice.value += 0.1;
      return r;
    }),
  });
});

const call = async (token: string | null, method: string, path: string, body?: unknown) => {
  const res = await app.request(path, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  return { status: res.status, body: (await res.json()) as any };
};
const MILK = { site: 'Hotel Kaisla Helsinki', deliver_by: '2026-11-16', items: [{ need: 'maito', quantity: 1000, unit: 'l' }], diets: ['lactose_free'], source_text: '1000 l lactose-free milk by Monday' };
const failed = (p: any) => p.policy_verdict.rules.filter((r: any) => !r.ok).map((r: any) => r.rule).sort();

test('OpenAPI is public, everything else needs a token', async () => {
  const doc = await call(null, 'GET', '/openapi.json');
  assert.equal(doc.status, 200);
  assert.ok(doc.body.paths['/proposals']);
  assert.ok(!JSON.stringify(doc.body.paths).includes('"/admin'));
  assert.equal((await call(null, 'GET', '/policy')).status, 401);
  assert.equal((await call('nope', 'GET', '/policy')).status, 401);
});

test('scene 1–4: best option with unconfirmed stock flagged, a sure-delivery option next to it; agent cannot approve; human picks, confirms, approves', async () => {
  const created = await call('demo-agent', 'POST', '/proposals', MILK);
  assert.equal(created.status, 200);
  const p = created.body;
  assert.equal(p.status, 'needs_review');
  assert.equal(p.requires_human, true);
  // Best option: Eila, cheapest, but Valio reports no amount for it → a person accepts it or not (policy, off by default).
  assert.deepEqual(failed(p), ['agent_may_finalise', 'confirmed_stock', 'max_line_eur', 'max_order_eur']);
  assert.deepEqual(p.items[0].allocation.map((l: any) => [l.id, l.sales_units, l.flags]), [['464306', 1000, ['E5']]]);
  assert.equal(p.total_cents, 101000);
  // Next to it, the same 1,000 l from confirmed stock only: 384 + 51 + 565 l across three products.
  const sure = p.items[0].sure_option;
  assert.deepEqual(sure.lines.map((l: any) => [l.id, l.units]), [['469363', 384], ['462775', 51], ['463380', 565]]);
  assert.deepEqual([sure.cost_cents, sure.extra_cents, sure.shortfall], [258064, 157064, 0]);

  assert.equal((await call('demo-agent', 'POST', `/proposals/${p.id}/decision`, { decision: 'approve' })).status, 403);

  const rev = (await call('demo-owner', 'PATCH', `/proposals/${p.id}`, { item: 0, confirmed_only: true })).body; // one click
  const parts = rev.items[0].allocation;
  assert.deepEqual(parts.map((l: any) => l.id), sure.lines.map((l: any) => l.id));
  assert.ok(parts.every((l: any) => !l.flags.includes('E5')));
  assert.ok(!failed(rev).includes('confirmed_stock'));
  assert.equal(rev.items[0].sure_option, null);

  bump = parts[0].id; // price moves before approval → back to review with the difference (§7.3)
  // Before approving, a person confirms the request was understood (no approvals yet, so no trust to skip it).
  const early = await call('demo-owner', 'POST', `/proposals/${p.id}/decision`, { decision: 'approve' });
  assert.deepEqual([early.status, early.body.needs_confirmation], [409, true]);
  assert.equal((await call('demo-agent', 'POST', `/proposals/${p.id}/confirm`)).status, 403);
  assert.equal((await call('demo-owner', 'POST', `/proposals/${p.id}/confirm`)).body.confirmation.required, false);
  const stale = await call('demo-owner', 'POST', `/proposals/${p.id}/decision`, { decision: 'approve' });
  bump = null;
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body.diffs.map((d: any) => [d.id, d.what]), [[parts[0].id, 'price_cents']]);
  assert.equal(stale.body.proposal.status, 'needs_review');

  const ok = await call('demo-owner', 'POST', `/proposals/${p.id}/decision`, { decision: 'approve', note: 'ok' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'approved');
  assert.equal((await call('demo-owner', 'PATCH', `/proposals/${p.id}`, { item: 0, quantity: 5 })).status, 409);

  const events = (await call('demo-owner', 'GET', `/audit?proposal=${p.id}`)).body.map((e: any) => e.event);
  assert.deepEqual(events, ['created', 'policy_verdict', 'revised', 'policy_verdict', 'request_confirmed', 'revalidation_failed', 'approved']);

  // Scene 5: export. The agent may not export what needed a human (hard rule 2); the approver may.
  assert.equal((await app.request(`/proposals/${p.id}/export`, { headers: { authorization: 'Bearer demo-agent' } })).status, 403);
  const file = await app.request(`/proposals/${p.id}/export`, { headers: { authorization: 'Bearer demo-owner' } });
  assert.equal(file.status, 200);
  const csv = (await file.text()).replace(/^\ufeff/, '').trim().split('\r\n').map((l) => l.split(';'));
  assert.deepEqual(csv[0], ['gtin', 'product_id', 'name', 'quantity', 'sales_unit', 'unit_price_eur', 'line_total_eur', 'delivery_date']);
  assert.deepEqual(csv.slice(1).map((r) => [r[1], r[3], r[7]]), parts.map((l: any) => [l.id, String(l.sales_units), l.date]));
  assert.ok(csv.slice(1).every((r) => /^\d{8,14}$/.test(r[0])), 'every line has a GTIN');
  assert.equal((await call('demo-owner', 'GET', `/proposals/${p.id}`)).body.status, 'exported');
});

test('policy: agent may finish routine orders within limits; an agent key can only tighten it', async () => {
  const loose = { agent_may_finalise: true, max_order_eur: 3000, max_line_eur: 3000 };
  assert.equal((await call('demo-agent', 'PUT', '/policy', loose)).status, 403); // only a person sets the policy
  assert.equal((await call('demo-owner', 'PUT', '/policy', loose)).status, 200);
  // Autonomy covers routine orders only: one approved milk order so far, three are needed. Until then a person sees
  // the best option (unconfirmed Eila) with the sure one next to it.
  for (let i = 0; i < 2; i++) {
    const p = (await call('demo-agent', 'POST', '/proposals', MILK)).body;
    assert.deepEqual(failed(p), ['confirmed_stock', 'routine_order']);
    await call('demo-owner', 'POST', `/proposals/${p.id}/confirm`);
    assert.equal((await call('demo-owner', 'POST', `/proposals/${p.id}/decision`, { decision: 'approve' })).status, 200);
  }
  // Routine now: finishing alone, the agent takes the sure-delivery option, never the unconfirmed one.
  const auto = (await call('demo-agent', 'POST', '/proposals', MILK)).body;
  assert.equal(auto.status, 'auto_approved');
  assert.equal(auto.requires_human, false);
  assert.deepEqual(auto.items[0].allocation.map((l: any) => l.id), ['469363', '462775', '463380']);
  assert.equal((await app.request(`/proposals/${auto.id}/export`, { headers: { authorization: 'Bearer demo-agent' } })).status, 200);
  // The same request typed in the app (owner token) is finished the same way: sure option, no sign-off needed.
  const typed = (await call('demo-owner', 'POST', '/proposals', MILK)).body;
  assert.deepEqual([typed.status, typed.items[0].allocation.map((l: any) => l.id)], ['auto_approved', ['469363', '462775', '463380']]);

  db.prepare("UPDATE tokens SET limits = ? WHERE token = 'demo-agent'").run(JSON.stringify({ max_order_eur: 100, agent_may_finalise: true }));
  const tight = (await call('demo-agent', 'POST', '/proposals', MILK)).body;
  db.prepare("UPDATE tokens SET limits = NULL WHERE token = 'demo-agent'").run();
  assert.equal(tight.status, 'needs_review');
  assert.deepEqual(failed(tight), ['confirmed_stock', 'max_order_eur']); // sure option over its limit too: the person decides

  // The owner accepts products Valio reports no amount for: the agent keeps the cheapest (Eila) and finishes alone.
  await call('demo-owner', 'PUT', '/policy', { ...loose, allow_unconfirmed_stock: true });
  const eila = (await call('demo-agent', 'POST', '/proposals', MILK)).body;
  assert.deepEqual([eila.status, eila.items[0].allocation.map((l: any) => l.id), eila.total_cents], ['auto_approved', ['464306'], 101000]);
  // An agent that leaves the person's words out cannot skip the quantity check.
  const { source_text, ...silent } = MILK;
  assert.deepEqual(failed((await call('demo-agent', 'POST', '/proposals', silent)).body), ['matches_request_text']);
  assert.equal((await call('demo-owner', 'POST', '/proposals', silent)).body.policy_verdict.rules.some((r: any) => r.rule === 'matches_request_text'), false);

  // Kill switch: only a person flips it; every agent key of the customer answers 403 while it is off.
  assert.equal((await call('demo-agent', 'PUT', '/agents', { enabled: false })).status, 403);
  assert.equal((await call('demo-owner', 'PUT', '/agents', { enabled: false })).body.enabled, false);
  assert.equal((await call('demo-agent', 'POST', '/proposals', MILK)).status, 403);
  assert.equal((await call('demo-owner', 'PUT', '/agents', { enabled: true })).status, 200);
  assert.equal((await call('demo-agent', 'GET', '/agents')).body.enabled, true);
  await call('demo-owner', 'PUT', '/policy', {});
});

test('no date given: the first date the order can still be placed for, not blindly tomorrow', async () => {
  const { deliver_by, ...undated } = MILK;
  const p = (await call('demo-owner', 'POST', '/proposals', undated)).body;
  assert.deepEqual([p.deliver_by, p.deliver_by_defaulted], ['2026-11-16', true]);
  assert.ok(!failed(p).includes('on_time'));
});

test('limits found in the source text are added even if the agent left them out', async () => {
  const r = (await call('demo-agent', 'POST', '/proposals', { ...MILK, diets: [], source_text: '1000 l lactose-free milk, no nuts' })).body;
  assert.deepEqual(r.request.diets, ['lactose_free']);
  assert.deepEqual(r.request.exclude_allergens, ['AN']);
  const parsed = (await call('demo-agent', 'POST', '/parse', { text: 'I need 1,000 litres of lactose-free milk by Monday' })).body;
  assert.equal(parsed.clarification, null);
  assert.equal(parsed.request.deliver_by, '2026-11-16');
});

test('trust: a quantity not in the text, or far from the usual one, needs a human', async () => {
  const loose = { agent_may_finalise: true, max_order_eur: 1e5, max_line_eur: 1e5 };
  await call('demo-owner', 'PUT', '/policy', loose);
  // The agent read "100" as 1000: plausible, under every limit, but not what was written.
  const typo = (await call('demo-agent', 'POST', '/proposals', { ...MILK, source_text: '100 l lactose-free milk by Monday' })).body;
  assert.equal(typo.status, 'needs_review');
  assert.ok(failed(typo).includes('matches_request_text')); // even the sure-delivery option cannot clear it
  assert.deepEqual(typo.read_back.items, [{ quantity_in_text: false, words: 'milk' }]);

  const { evaluate, PolicySchema: P } = await import('./policy.ts');
  const item = (quantity: number) => ({ item: { need: 'maito', quantity, unit: 'l' }, category: '10400', allocation: [], shortfall: 0, errors: [], options: [] });
  const history = new Map([['10400|l', [150, 200, 180, 220, 200]]]);
  const rule = (q: number, h = history) => evaluate(db, [item(q)], {}, P.parse(loose), h).rules.find((r) => r.rule === 'usual_quantity')!;
  assert.match(rule(1000).detail, /usually 200 l \(5 past orders\)/);
  assert.equal(rule(1000).ok, false);
  assert.equal(rule(20).ok, false);
  assert.equal(rule(300).ok, true);
  assert.equal(rule(1000, new Map([['10400|l', [200, 200]]])).ok, true); // too little history to judge
  await call('demo-owner', 'PUT', '/policy', {});
});

test('recipe: scaled to portions, the named Valio product preferred, every quantity traced to its line', async () => {
  const path = join(tmpdir(), `tta-recipes-${process.pid}.json`);
  const line = (text: string, kg: number, need: string | null, product: string | null = null, pantry = false) => ({ text, kg, need, product, pantry });
  writeFileSync(path, JSON.stringify([
    { id: 'r1', name: 'Maitokeitto', url: 'https://example.invalid/r1', image: null, yield: 10, course: 'Soup', diets: [], lines: [
      line('2,000 kg Arla maitoa', 2, 'maito', '462775'), line('0,500 kg vettä', 0.5, null), line('0,010 kg suolaa', 0.01, 'suola', null, true)] },
    { id: 'r2', name: 'Toinen', url: 'https://example.invalid/r2', image: null, yield: 10, course: 'Soup', diets: [], lines: [
      line('2,000 kg Valio maitoa', 2, 'maito', '464440')] },
  ]));
  process.env.RECIPES_PATH = path;
  try {
    assert.deepEqual((await call('demo-owner', 'GET', '/recipes')).body.map((r: any) => [r.id, r.ingredients]), [['r1', 3], ['r2', 1]]);
    const plan = (id: string) => call('demo-owner', 'POST', `/recipes/${id}/plan`, { portions: 50, deliver_by: '2026-11-16', diets: ['lactose_free'] });
    const p = (await plan('r1')).body;
    assert.equal(p.request.recipe.from[0], '2,000 kg Arla maitoa × 50/10 portions = 10 kg');
    assert.deepEqual(p.request.recipe.skipped.map((x: any) => x.reason), ['nothing to buy', 'usually in stock']);
    assert.deepEqual([p.items[0].allocation[0].id, p.items[0].named.used], ['462775', true]); // not the top-ranked product
    assert.match(p.items[0].allocation[0].reason, /named in the request/);
    assert.ok(!failed(p).includes('matches_request_text'), 'no source text: quantities come from the recipe');

    const q = (await plan('r2')).body; // named product cannot be delivered → the best other option, with the reason
    assert.equal(q.items[0].named.used, false);
    assert.match(q.items[0].named.why, /E2/);
    assert.notEqual(q.items[0].allocation[0].id, '464440');
    assert.equal((await call('demo-owner', 'POST', '/recipes/nope/plan', { portions: 5 })).status, 404);
  } finally {
    delete process.env.RECIPES_PATH;
    rmSync(path, { force: true });
  }
});

test('correcting the request re-plans the same proposal, clears the confirmation, and is a human change', async () => {
  const p = (await call('demo-owner', 'POST', '/proposals', { ...MILK, source_text: '1000 l lactose-free milk by Monday' })).body;
  await call('demo-owner', 'POST', `/proposals/${p.id}/confirm`);
  assert.ok((await call('demo-owner', 'GET', `/proposals/${p.id}`)).body.confirmation.done);
  assert.equal((await call('demo-agent', 'PATCH', `/proposals/${p.id}/request`, { deliver_by: '2026-11-18' })).status, 403);
  const fixed = (await call('demo-owner', 'PATCH', `/proposals/${p.id}/request`, { items: [{ need: 'maito', quantity: 100, unit: 'l' }] })).body;
  assert.equal(fixed.id, p.id);
  assert.equal(fixed.items[0].item.quantity, 100);
  assert.equal(fixed.confirmation.done, null);
  assert.deepEqual(fixed.request.diets, ['lactose_free']); // limits found in the words stay
  assert.ok(failed(fixed).includes('matches_request_text')); // 100 is not in the words: a person confirms that
  const events = (await call('demo-owner', 'GET', `/audit?proposal=${p.id}`)).body.map((e: any) => e.event);
  assert.deepEqual(events.slice(-2), ['request_corrected', 'policy_verdict']);
  await call('demo-owner', 'POST', `/proposals/${p.id}/decision`, { decision: 'reject' });
});

test('a date in the past asks for clarification', async () => {
  const r = await call('demo-owner', 'POST', '/proposals', { ...MILK, deliver_by: '2026-11-01' });
  assert.equal(r.status, 400);
  assert.match(r.body.question, /past/);
});

test('audit is append-only at the database level', () => {
  assert.throws(() => db.exec('UPDATE audit SET event = 1'), /append-only/);
  assert.throws(() => db.exec('DELETE FROM audit'), /append-only/);
});

test('hard rules: alcohol, policy errors and agent limits never loosen anything', () => {
  const all = PolicySchema.parse({ agent_may_finalise: true, max_order_eur: 1e6, max_line_eur: 1e6, allow_unknown_amount: true });
  const line = { id: '464306', name: 'Bad Santa Alkoholijäätelö 4.2% 120ml', unit_price_cents: 100, sales_units: 1, sales_unit: 'ST', covers: 1, cost_cents: 100, date: '2026-11-16', flags: [], reason: '' };
  const v = evaluate(db, [{ item: { need: 'x', quantity: 1, unit: 'pcs' }, allocation: [line], shortfall: 0, errors: [], options: [{ unit_price_cents: 100 }] }], {}, all);
  assert.deepEqual(v.rules.filter((r) => !r.ok && r.hard).map((r) => r.rule), ['alcohol_needs_human']);

  const broken = evaluate(db, [null as any], {}, all);
  assert.equal(broken.requires_human, true);
  assert.equal(broken.rules[0].rule, 'policy_engine');

  const base = PolicySchema.parse({});
  assert.deepEqual(effectivePolicy(base, { agent_may_finalise: true, max_order_eur: 1e6, allow_split: false }), { ...base, allow_split: false });
});

test('trust ladder: 3 unchanged approvals suggest autonomy, learned from what was accepted; a rejected autonomous order revokes it', async () => {
  const create = async () => (await call('demo-agent', 'POST', '/proposals', MILK)).body;
  const decide = async (id: string, decision: string) => {
    if (decision === 'approve' && (await call('demo-owner', 'GET', `/proposals/${id}`)).body.confirmation.required) await call('demo-owner', 'POST', `/proposals/${id}/confirm`);
    return call('demo-owner', 'POST', `/proposals/${id}/decision`, { decision });
  };
  await call('demo-owner', 'PUT', '/policy', { allow_split: false }); // so every milk proposal (a split) asks about splitting
  await decide((await create()).id, 'reject'); // a clean streak
  const approveNew = async (revise = false) => {
    const p = await create();
    await call('demo-owner', 'PATCH', `/proposals/${p.id}`, { item: 0, confirmed_only: true }); // the agent's own offer: not a fix
    if (revise) await call('demo-owner', 'PATCH', `/proposals/${p.id}`, { item: 0, quantity: 900 });
    assert.equal((await decide(p.id, 'approve')).status, 200);
  };
  for (let i = 0; i < 2; i++) await approveNew();
  assert.equal((await call('demo-owner', 'GET', '/trust')).body.suggestion, null);
  await approveNew();
  const t = (await call('demo-owner', 'GET', '/trust')).body;
  assert.equal(t.streak, 3);
  const next = await create(); // trusted now: no "is this what you meant?" step
  assert.deepEqual([next.confirmation.required, next.confirmation.skipped_by_trust], [false, true]);
  assert.match(t.suggestion.text, /3 proposals in a row.*split across products/);
  assert.deepEqual(t.suggestion.learned, ['allow_split']); // accepted every time → learned; unconfirmed stock was never accepted here
  const s = t.suggestion.policy;
  assert.deepEqual([s.agent_may_finalise, s.max_order_eur, s.max_line_eur, s.allow_split], [true, 2600, 2600, true]);
  assert.equal((await call('demo-owner', 'GET', '/policy')).body.agent_may_finalise, false); // nothing changes by itself

  await call('demo-owner', 'PUT', '/policy', s);
  const auto = await create();
  assert.equal(auto.status, 'auto_approved');
  await decide(auto.id, 'reject'); // trust is lost faster than it is earned
  assert.equal((await call('demo-owner', 'GET', '/policy')).body.agent_may_finalise, false);
  assert.ok((await call('demo-owner', 'GET', `/audit?proposal=${auto.id}`)).body.some((e: any) => e.event === 'autonomy_revoked'));

  await approveNew(true);
  assert.equal((await call('demo-owner', 'GET', '/trust')).body.streak, 0);
  await call('demo-owner', 'PUT', '/policy', {});
});

test('stock: the agent refills what runs low from the kitchen\'s stock system, once, under its own key', async () => {
  const st = (await call('demo-owner', 'GET', '/stock')).body;
  const low = st.items.filter((i: any) => i.low).map((i: any) => [i.need, i.order, i.unit, i.deliver_by]);
  assert.deepEqual(low, [['maito', 200, 'l', '2026-11-16'], ['voi', 10, 'kg', '2026-11-16']]); // 2 days left each, refill to par

  await call('demo-owner', 'PUT', '/agents', { enabled: false });
  assert.equal((await call('demo-owner', 'POST', '/stock/check')).status, 403); // kill switch stops this too
  await call('demo-owner', 'PUT', '/agents', { enabled: true });

  const { created } = (await call('demo-owner', 'POST', '/stock/check')).body;
  assert.equal(created.length, 2);
  const milk = created.find((p: any) => p.request.items[0].need === 'maito');
  assert.equal(milk.created_by, 'agent:Buyer agent'); // a person asked, the agent made it
  assert.deepEqual([milk.request.stock.on_hand, milk.request.stock.par, milk.request.diets], [80, 280, ['lactose_free']]);
  assert.ok(!failed(milk).includes('matches_request_text')); // gateway-computed quantity, no words to check
  assert.equal((await call('demo-owner', 'POST', '/stock/check')).body.created.length, 0); // already on the way
  await call('demo-owner', 'POST', `/proposals/${milk.id}/decision`, { decision: 'reject' });
  const again = (await call('demo-agent', 'POST', '/stock/check')).body.created;
  assert.deepEqual(again.map((p: any) => p.request.items[0].need), ['maito']); // rejected → low again
  // A person's fix keeps where the order came from.
  const fixed = (await call('demo-owner', 'PATCH', `/proposals/${again[0].id}/request`, { items: [{ need: 'maito', quantity: 150, unit: 'l' }] })).body;
  assert.equal(fixed.request.stock.name, 'Lactose-free milk');
});

test('MCP: an outside agent gets the same guardrails and no approve tool', async () => {
  const { serve } = await import('@hono/node-server');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const server = await new Promise<any>((ok) => { const s = serve({ fetch: app.fetch, port: 0 }, () => ok(s)); });
  const client = new Client({ name: 'test-agent', version: '0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: ['--disable-warning=ExperimentalWarning', 'src/mcp.ts'],
    env: { ...process.env, GATEWAY_URL: `http://localhost:${server.address().port}`, AGENT_TOKEN: 'demo-agent' } as Record<string, string>,
  }));
  try {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['check_offers', 'check_stock', 'create_proposal', 'export_proposal', 'get_product', 'get_proposal', 'revise_proposal', 'search_products']);
    const text = (r: any) => JSON.parse(r.content[0].text);
    const found = text(await client.callTool({ name: 'search_products', arguments: { q: 'maito', diets: ['lactose_free'] } }));
    assert.ok(found.matches.some((p: any) => p.id === '464306'));
    const p = text(await client.callTool({ name: 'create_proposal', arguments: MILK }));
    assert.equal(p.requires_human, true);
    assert.match(p.next, /A person must review/);
    const bad = await client.callTool({ name: 'get_proposal', arguments: { id: 'nope' } });
    assert.equal(bad.isError, true);
  } finally {
    await client.close();
    server.close();
  }
});

test('accounts: invite code, a kitchen of your own with the demo history, sessions; hosted mode switches the demo tokens off', async () => {
  process.env.INVITE_CODE = 'letmein';
  const who = { name: 'Judge', email: 'Judge@Example.com', password: 'correct horse' };
  assert.equal((await call(null, 'POST', '/auth/register', who)).status, 403);
  const r = await call(null, 'POST', '/auth/register', { ...who, invite: 'letmein' });
  delete process.env.INVITE_CODE;
  assert.deepEqual([r.status, r.body.history], [200, 2]);
  assert.equal((await call(null, 'POST', '/auth/register', who)).status, 409);

  // Own kitchen: the two approved milk orders of the demo history, none of the demo kitchen's proposals.
  const mine = (await call(r.body.token, 'GET', '/proposals')).body;
  assert.deepEqual(mine.map((p: any) => p.status), ['approved', 'approved']);
  const theirs = (await call('demo-owner', 'GET', '/proposals')).body.map((p: any) => p.id);
  assert.ok(theirs.length && mine.every((p: any) => !theirs.includes(p.id)));
  assert.equal((await call(r.body.token, 'GET', `/proposals/${theirs[0]}`)).status, 404);
  assert.equal((await call(r.body.token, 'GET', '/trust')).body.streak, 2); // the third approval earns trust, as in the demo
  assert.equal((await call(r.body.token, 'GET', '/stock')).status, 200);

  assert.equal((await call(null, 'POST', '/auth/login', { email: 'judge@example.com', password: 'wrong password' })).status, 401);
  const s = (await call(null, 'POST', '/auth/login', { email: 'judge@example.com', password: 'correct horse' })).body;
  assert.deepEqual((await call(s.token, 'GET', '/me')).body, { name: 'Judge', role: 'owner', email: 'judge@example.com', kitchen: 'Hotel Kaisla' });
  await call(s.token, 'POST', '/auth/logout');
  assert.equal((await call(s.token, 'GET', '/me')).status, 401);

  process.env.HOSTED = '1'; seed(db);
  assert.equal((await call('demo-owner', 'GET', '/policy')).status, 401);
  assert.equal((await call(null, 'GET', '/auth/config')).body.demo_kitchen, false);
  delete process.env.HOSTED; seed(db);
  assert.equal((await call('demo-owner', 'GET', '/policy')).status, 200);
});
