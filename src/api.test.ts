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
fresh.exec(`DROP TABLE audit; DROP TABLE proposals; DROP TABLE tokens; DROP TABLE customers;`);
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
      const r = JSON.parse(snap.get(`${ep}|${id}|${requestedDate}`) ?? (ep === 'price'
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
const MILK = { site: 'Hotel Kaisla Helsinki', deliver_by: '2026-11-16', items: [{ need: 'maito', quantity: 1000, unit: 'l' }], diets: ['lactose_free'] };
const failed = (p: any) => p.policy_verdict.rules.filter((r: any) => !r.ok).map((r: any) => r.rule).sort();

test('OpenAPI is public, everything else needs a token', async () => {
  const doc = await call(null, 'GET', '/openapi.json');
  assert.equal(doc.status, 200);
  assert.ok(doc.body.paths['/proposals']);
  assert.ok(!JSON.stringify(doc.body.paths).includes('"/admin'));
  assert.equal((await call(null, 'GET', '/policy')).status, 401);
  assert.equal((await call('nope', 'GET', '/policy')).status, 401);
});

test('scene 1–4: agent proposes, cannot approve, human revises to confirmed stock, approves', async () => {
  const created = await call('demo-agent', 'POST', '/proposals', MILK);
  assert.equal(created.status, 200);
  const p = created.body;
  assert.equal(p.status, 'needs_review');
  assert.equal(p.requires_human, true);
  assert.deepEqual(failed(p), ['agent_may_finalise', 'allow_unknown_amount', 'max_line_eur', 'max_order_eur']);
  assert.equal(p.items[0].allocation[0].id, '464306');

  assert.equal((await call('demo-agent', 'POST', `/proposals/${p.id}/decision`, { decision: 'approve' })).status, 403);
  assert.equal((await call('demo-requester', 'POST', `/proposals/${p.id}/decision`, { decision: 'approve' })).status, 403);

  const rev = (await call('demo-approver', 'PATCH', `/proposals/${p.id}`, { item: 0, confirmed_only: true })).body;
  const parts = rev.items[0].allocation;
  assert.ok(parts.length >= 2 && parts.length <= 3);
  assert.ok(parts.every((l: any) => !l.flags.includes('E5') && l.flags.includes('E4')));
  assert.equal(parts[0].id, '469363');
  assert.equal(parts[0].sales_units, 384);

  bump = parts[0].id; // price moves before approval → back to review with the difference (§7.3)
  const stale = await call('demo-approver', 'POST', `/proposals/${p.id}/decision`, { decision: 'approve' });
  bump = null;
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body.diffs.map((d: any) => [d.id, d.what]), [[parts[0].id, 'price_cents']]);
  assert.equal(stale.body.proposal.status, 'needs_review');

  const ok = await call('demo-approver', 'POST', `/proposals/${p.id}/decision`, { decision: 'approve', note: 'ok' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'approved');
  assert.equal((await call('demo-approver', 'PATCH', `/proposals/${p.id}`, { item: 0, quantity: 5 })).status, 409);

  const events = (await call('demo-requester', 'GET', `/audit?proposal=${p.id}`)).body.map((e: any) => e.event);
  assert.deepEqual(events, ['created', 'policy_verdict', 'revised', 'policy_verdict', 'revalidation_failed', 'approved']);

  // Scene 5: export. The agent may not export what needed a human (hard rule 2); the approver may.
  assert.equal((await app.request(`/proposals/${p.id}/export`, { headers: { authorization: 'Bearer demo-agent' } })).status, 403);
  const file = await app.request(`/proposals/${p.id}/export`, { headers: { authorization: 'Bearer demo-approver' } });
  assert.equal(file.status, 200);
  const csv = (await file.text()).replace(/^\ufeff/, '').trim().split('\r\n').map((l) => l.split(';'));
  assert.deepEqual(csv[0], ['gtin', 'product_id', 'name', 'quantity', 'sales_unit', 'unit_price_eur', 'line_total_eur', 'delivery_date']);
  assert.deepEqual(csv.slice(1).map((r) => [r[1], r[3], r[7]]), parts.map((l: any) => [l.id, String(l.sales_units), l.date]));
  assert.ok(csv.slice(1).every((r) => /^\d{8,14}$/.test(r[0])), 'every line has a GTIN');
  assert.equal((await call('demo-approver', 'GET', `/proposals/${p.id}`)).body.status, 'exported');
});

test('policy: agent may finalise within limits; an agent key can only tighten it', async () => {
  const loose = { agent_may_finalise: true, max_order_eur: 2000, max_line_eur: 2000, allow_unknown_amount: true };
  assert.equal((await call('demo-agent', 'PUT', '/policy', loose)).status, 403);
  assert.equal((await call('demo-approver', 'PUT', '/policy', loose)).status, 200);
  const auto = (await call('demo-agent', 'POST', '/proposals', MILK)).body;
  assert.equal(auto.status, 'auto_approved');
  assert.equal(auto.requires_human, false);
  assert.equal((await app.request(`/proposals/${auto.id}/export`, { headers: { authorization: 'Bearer demo-agent' } })).status, 200);

  db.prepare("UPDATE tokens SET limits = ? WHERE token = 'demo-agent'").run(JSON.stringify({ max_order_eur: 100, agent_may_finalise: true }));
  const tight = (await call('demo-agent', 'POST', '/proposals', MILK)).body;
  db.prepare("UPDATE tokens SET limits = NULL WHERE token = 'demo-agent'").run();
  assert.equal(tight.status, 'needs_review');
  assert.deepEqual(failed(tight), ['max_order_eur']);

  db.prepare("UPDATE customers SET agents_enabled = 0 WHERE id = 'kaisla'").run(); // kill switch
  assert.equal((await call('demo-agent', 'POST', '/proposals', MILK)).status, 403);
  db.prepare("UPDATE customers SET agents_enabled = 1 WHERE id = 'kaisla'").run();
  await call('demo-approver', 'PUT', '/policy', {});
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
  const loose = { agent_may_finalise: true, max_order_eur: 1e5, max_line_eur: 1e5, allow_unknown_amount: true };
  await call('demo-approver', 'PUT', '/policy', loose);
  // The agent read "100" as 1000: plausible, under every limit, but not what was written.
  const typo = (await call('demo-agent', 'POST', '/proposals', { ...MILK, source_text: '100 l lactose-free milk by Monday' })).body;
  assert.equal(typo.status, 'needs_review');
  assert.deepEqual(failed(typo), ['matches_request_text']);
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
  await call('demo-approver', 'PUT', '/policy', {});
});

test('recipe: scaled to portions, the named Valio product preferred, every quantity traced to its line', async () => {
  const path = join(tmpdir(), `tta-recipes-${process.pid}.json`);
  const line = (text: string, kg: number, need: string | null, product: string | null = null, pantry = false) => ({ text, kg, need, product, pantry });
  writeFileSync(path, JSON.stringify([
    { id: 'r1', name: 'Maitokeitto', url: 'https://example.invalid/r1', image: null, yield: 10, course: 'Soup', diets: [], lines: [
      line('2,000 kg Valio Eila maitoa', 2, 'maito', '464306'), line('0,500 kg vettä', 0.5, null), line('0,010 kg suolaa', 0.01, 'suola', null, true)] },
    { id: 'r2', name: 'Toinen', url: 'https://example.invalid/r2', image: null, yield: 10, course: 'Soup', diets: [], lines: [
      line('2,000 kg Valio maitoa', 2, 'maito', '464440')] },
  ]));
  process.env.RECIPES_PATH = path;
  try {
    assert.deepEqual((await call('demo-requester', 'GET', '/recipes')).body.map((r: any) => [r.id, r.ingredients]), [['r1', 3], ['r2', 1]]);
    const plan = (id: string) => call('demo-requester', 'POST', `/recipes/${id}/plan`, { portions: 50, deliver_by: '2026-11-16', diets: ['lactose_free'] });
    const p = (await plan('r1')).body;
    assert.equal(p.request.recipe.from[0], '2,000 kg Valio Eila maitoa × 50/10 portions = 10 kg');
    assert.deepEqual(p.request.recipe.skipped.map((x: any) => x.reason), ['nothing to buy', 'usually in stock']);
    assert.deepEqual([p.items[0].allocation[0].id, p.items[0].named.used], ['464306', true]);
    assert.match(p.items[0].allocation[0].reason, /named in the request/);
    assert.ok(!failed(p).includes('matches_request_text'), 'no source text: quantities come from the recipe');

    const q = (await plan('r2')).body; // named product cannot be delivered → the best other option, with the reason
    assert.equal(q.items[0].named.used, false);
    assert.match(q.items[0].named.why, /E2/);
    assert.notEqual(q.items[0].allocation[0].id, '464440');
    assert.equal((await call('demo-requester', 'POST', '/recipes/nope/plan', { portions: 5 })).status, 404);
  } finally {
    delete process.env.RECIPES_PATH;
    rmSync(path, { force: true });
  }
});

test('a date in the past asks for clarification', async () => {
  const r = await call('demo-requester', 'POST', '/proposals', { ...MILK, deliver_by: '2026-11-01' });
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
  assert.deepEqual(v.rules.filter((r) => !r.ok).map((r) => r.rule), ['alcohol_needs_human']);

  const broken = evaluate(db, [null as any], {}, all);
  assert.equal(broken.requires_human, true);
  assert.equal(broken.rules[0].rule, 'policy_engine');

  const base = PolicySchema.parse({});
  assert.deepEqual(effectivePolicy(base, { agent_may_finalise: true, max_order_eur: 1e6, allow_split: false }), { ...base, allow_split: false });
});

test('trust ladder: 5 unchanged approvals suggest autonomy; a human change resets it; nothing changes by itself', async () => {
  const approveNew = async (revise = false) => {
    const p = (await call('demo-agent', 'POST', '/proposals', MILK)).body;
    if (revise) await call('demo-approver', 'PATCH', `/proposals/${p.id}`, { item: 0, quantity: 900 });
    assert.equal((await call('demo-approver', 'POST', `/proposals/${p.id}/decision`, { decision: 'approve' })).status, 200);
  };
  for (let i = 0; i < 4; i++) await approveNew();
  assert.equal((await call('demo-approver', 'GET', '/trust')).body.suggestion, null);
  await approveNew();
  const t = (await call('demo-approver', 'GET', '/trust')).body;
  assert.equal(t.streak, 5);
  assert.match(t.suggestion.text, /5 proposals in a row/);
  assert.deepEqual([t.suggestion.policy.agent_may_finalise, t.suggestion.policy.max_order_eur, t.suggestion.policy.max_line_eur], [true, 1050, 1050]);
  assert.equal((await call('demo-approver', 'GET', '/policy')).body.agent_may_finalise, false);
  await approveNew(true);
  assert.equal((await call('demo-approver', 'GET', '/trust')).body.streak, 0);
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
    assert.deepEqual(names, ['check_offers', 'create_proposal', 'export_proposal', 'get_product', 'get_proposal', 'revise_proposal', 'search_products']);
    const text = (r: any) => JSON.parse(r.content[0].text);
    const found = text(await client.callTool({ name: 'search_products', arguments: { q: 'maito', diets: ['lactose_free'] } }));
    assert.ok(found.matches.some((p: any) => p.id === '464306'));
    const p = text(await client.callTool({ name: 'create_proposal', arguments: MILK }));
    assert.equal(p.requires_human, true);
    assert.match(p.next, /human approver/);
    const bad = await client.callTool({ name: 'get_proposal', arguments: { id: 'nope' } });
    assert.equal(bad.isError, true);
  } finally {
    await client.close();
    server.close();
  }
});
