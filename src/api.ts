// Gateway: REST + OpenAPI (context.md §5). MCP tools wrap the same functions. Run: `npm start`.
import { OpenAPIHono, createRoute, z, type RouteConfig } from '@hono/zod-openapi';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.ts';
import { search, getProduct } from './catalogue.ts';
import { checkOffers, now } from './offers.ts';
import { planItem, PRESETS, type Overrides, type Priorities } from './planner.ts';
import { evaluate, effectivePolicy, PolicySchema, type Policy, type Verdict } from './policy.ts';
import { detectLimits, parseRequest } from './parse.ts';

type Role = 'requester' | 'approver' | 'agent';
type Actor = { customer: string; name: string; role: Role; limits: Partial<Policy> | null };
type Status = 'needs_review' | 'auto_approved' | 'approved' | 'rejected' | 'expired' | 'exported';

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).openapi({ example: '2026-11-16' });
const Diet = z.enum(['lactose_free', 'gluten_free', 'vegan', 'vegetarian']);
export const PurchaseRequest = z.object({
  site: z.string().min(1).max(200).openapi({ example: 'Hotel Kaisla Helsinki' }),
  deliver_by: DateStr.optional(),
  items: z.array(z.object({
    need: z.string().min(1).max(200).openapi({ example: 'maito' }),
    quantity: z.number().positive().max(1_000_000).openapi({ example: 1000 }),
    unit: z.enum(['kg', 'l', 'pcs']),
  })).min(1).max(20),
  exclude_allergens: z.array(z.string().regex(/^[A-Z]{2}$/)).default([]).openapi({ description: 'GS1 allergen codes, e.g. AM milk, AW gluten' }),
  diets: z.array(Diet).default([]),
  labels_required: z.array(z.string().max(80)).default([]),
  priorities: z.enum(Object.keys(PRESETS) as [Priorities, ...Priorities[]]).default('price_and_availability'),
  budget_eur: z.number().positive().nullable().default(null),
  source_text: z.string().max(5000).optional(),
}).openapi('PurchaseRequest');
type Request = z.infer<typeof PurchaseRequest> & { deliver_by: string; deliver_by_defaulted?: boolean };

const Revision = z.object({
  item: z.number().int().min(0),
  quantity: z.number().positive().max(1_000_000).optional(),
  choose: z.string().optional().openapi({ description: 'Product id from this item\'s options' }),
  confirmed_only: z.boolean().optional().openapi({ description: 'Allocate only from options with a confirmed amount' }),
}).openapi('Revision');
const Decision = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(1000).optional() }).openapi('Decision');

// ponytail: fixed demo tokens for the fictional customer. Generate real keys before anything leaves localhost.
export function seed(db: DatabaseSync) {
  db.exec(`
    INSERT OR IGNORE INTO customers (id, name) VALUES ('kaisla', 'Hotel Kaisla');
    INSERT OR IGNORE INTO tokens (token, customer, name, role) VALUES
      ('demo-approver', 'kaisla', 'Purchasing manager', 'approver'),
      ('demo-requester', 'kaisla', 'Chef', 'requester'),
      ('demo-agent', 'kaisla', 'Buyer agent', 'agent');`);
}

const helsinkiToday = () => now().toLocaleDateString('en-CA', { timeZone: 'Europe/Helsinki' });
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

const json = (description: string) => ({ description, content: { 'application/json': { schema: z.any() } } });
const responses = {
  200: json('OK'), 400: json('Invalid request, or a clarification is needed'), 401: json('Missing or unknown token'),
  403: json('Not allowed for this role'), 404: json('Not found'), 409: json('Conflicts with the current state'),
};
const route = <M extends RouteConfig['method'], P extends string, R extends RouteConfig['request'] = {}>(
  method: M, path: P, summary: string, request?: R,
) => createRoute({ method, path, summary, security: [{ bearer: [] }], request: request as R, responses });
const body = <T extends z.ZodType>(schema: T) => ({ body: { content: { 'application/json': { schema } }, required: true } });
const IdParam = z.object({ id: z.string() });

export function createApp(db: DatabaseSync) {
  const app = new OpenAPIHono<{ Variables: { actor: Actor } }>({
    defaultHook: (r, c) => { if (!r.success) return c.json({ error: 'invalid request', issues: r.error.issues }, 400); },
  });
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearer', { type: 'http', scheme: 'bearer' });
  app.doc31('/openapi.json', { openapi: '3.1.0', info: { title: 'Trusted Trade Agents gateway', version: '0.1.0' } });
  app.onError((e, c) => c.json({ error: (e as Error).message }, 500));

  app.use('*', async (c, next) => {
    if (c.req.path === '/openapi.json') return next();
    const token = c.req.header('authorization')?.replace(/^Bearer /i, '');
    const t = token && db.prepare(
      `SELECT t.customer, t.name, t.role, t.limits, c.agents_enabled FROM tokens t JOIN customers c ON c.id = t.customer
       WHERE t.token = ? AND NOT t.revoked`,
    ).get(token) as any;
    if (!t) return c.json({ error: 'missing or unknown token' }, 401);
    if (t.role === 'agent' && !t.agents_enabled) return c.json({ error: 'agents are switched off for this customer' }, 403);
    c.set('actor', { customer: t.customer, name: t.name, role: t.role, limits: t.limits ? JSON.parse(t.limits) : null });
    return next();
  });

  // --- storage helpers -------------------------------------------------------------------------------------------
  const policyOf = (customer: string): Policy => {
    const r = db.prepare('SELECT policy FROM customers WHERE id = ?').get(customer) as { policy: string | null };
    return PolicySchema.parse(r.policy ? JSON.parse(r.policy) : {});
  };
  const audit = (proposal: string | null, a: Actor, event: string, data: unknown) =>
    db.prepare('INSERT INTO audit (proposal, customer, at, actor, event, data) VALUES (?,?,?,?,?,?)')
      .run(proposal, a.customer, new Date().toISOString(), `${a.role}:${a.name}`, event, JSON.stringify(data));
  const load = (id: string, a: Actor) => {
    const r = db.prepare('SELECT * FROM proposals WHERE id = ? AND customer = ?').get(id, a.customer) as any;
    return r && { ...r, request: JSON.parse(r.request) as Request, items: JSON.parse(r.items) as any[], verdict: JSON.parse(r.verdict) as Verdict, status: r.status as Status };
  };
  const save = (p: { id: string; status: Status; request: Request; items: any[]; verdict: Verdict }) =>
    db.prepare('UPDATE proposals SET status = ?, request = ?, items = ?, verdict = ?, updated_at = ? WHERE id = ?')
      .run(p.status, JSON.stringify(p.request), JSON.stringify(p.items), JSON.stringify(p.verdict), new Date().toISOString(), p.id);

  const NEXT: Record<Status, string> = {
    needs_review: 'A human approver must review and approve this proposal. Agents cannot approve.',
    auto_approved: 'Every policy rule passed: the agent may export it. A human can still reject it until export.',
    approved: 'Approved by a human. Ready for export.',
    rejected: 'Rejected. Nothing will be ordered.', expired: 'Expired: an order cut-off passed. Create a new proposal.',
    exported: 'Exported for webshop import.',
  };
  const view = (p: any) => ({
    id: p.id, status: p.status, site: p.request.site, deliver_by: p.request.deliver_by,
    deliver_by_defaulted: !!p.request.deliver_by_defaulted, total_cents: p.verdict.total_cents,
    requires_human: p.verdict.requires_human, next: NEXT[p.status as Status], policy_verdict: p.verdict,
    // Full excluded lists stay in the audit record; responses carry the first 20 so agents' context stays small.
    items: p.items.map((it: any) => ({ ...it, excluded: it.excluded.slice(0, 20), excluded_total: it.excluded.length })),
    request: p.request, created_by: p.created_by, created_at: p.created_at, updated_at: p.updated_at,
  });

  // Plan one item; options keep their offers and scores (decision record), drop the bulky product records.
  const plan = async (r: Request, i: number, overrides: Overrides = {}) => {
    const limits = { exclude_allergens: r.exclude_allergens, diets: r.diets, labels_required: r.labels_required };
    const res = await planItem(db, r.items[i], limits, r.deliver_by, r.priorities, overrides);
    return { ...res, options: res.options.map(({ product, ...o }) => o) };
  };
  const verdictFor = (r: Request, items: any[], a: Actor) =>
    evaluate(db, items, { exclude_allergens: r.exclude_allergens, diets: r.diets, labels_required: r.labels_required, budget_eur: r.budget_eur },
      effectivePolicy(policyOf(a.customer), a.role === 'agent' ? a.limits : null));

  // --- catalogue and offers ----------------------------------------------------------------------------------------
  const list = z.string().optional().transform((s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []));
  app.openapi(route('get', '/products/search', 'Search products (local data, no API call)', {
    query: z.object({
      q: z.string().min(1), diets: list.pipe(z.array(Diet)), exclude_allergens: list, labels: list,
      origin: z.string().optional(), limit: z.coerce.number().int().min(1).max(50).default(50),
    }),
  }), (c) => {
    const q = c.req.valid('query');
    const r = search(db, q.q, { diets: q.diets, exclude_allergens: q.exclude_allergens, labels_required: q.labels, origin: q.origin }, q.limit);
    return c.json({
      category: r.category, matches: r.matches,
      excluded: r.excluded.slice(0, 50).map((e) => ({ id: e.product.id, name: e.product.name_fi ?? e.product.name_en, reasons: e.reasons })),
      excluded_total: r.excluded.length,
    }, 200);
  });

  app.openapi(route('get', '/products/{id}', 'Static product data', { params: IdParam }), (c) => {
    const p = getProduct(db, c.req.valid('param').id);
    return p ? c.json(p, 200) : c.json({ error: 'no such product' }, 404);
  });

  app.openapi(route('post', '/offers', 'Price and availability for up to 50 products (calls Valio)', body(z.object({
    ids: z.array(z.string()).min(1).max(50), date: DateStr,
  }))), async (c) => {
    const { ids, date } = c.req.valid('json');
    return c.json(await checkOffers(db, ids, date), 200);
  });

  // --- proposals ---------------------------------------------------------------------------------------------------
  app.openapi(route('post', '/proposals', 'Plan a purchase request into a proposal with a policy verdict', body(PurchaseRequest)), async (c) => {
    const a = c.get('actor');
    const input = c.req.valid('json');
    const today = helsinkiToday();
    if (input.deliver_by && input.deliver_by < today)
      return c.json({ error: 'clarification needed', question: `The delivery date ${input.deliver_by} is in the past. Which date do you need?` }, 400);
    // §6: limits the keyword detector finds in the source text are always added; an agent cannot drop them.
    const found = detectLimits(input.source_text ?? '');
    const r: Request = {
      ...input, deliver_by: input.deliver_by ?? addDays(today, 1), deliver_by_defaulted: !input.deliver_by,
      diets: [...new Set([...input.diets, ...found.diets])], exclude_allergens: [...new Set([...input.exclude_allergens, ...found.exclude_allergens])],
    };
    const items = [];
    for (let i = 0; i < r.items.length; i++) items.push(await plan(r, i)); // sequential: no API bursts
    const verdict = verdictFor(r, items, a);
    const p = { id: randomUUID(), status: (verdict.requires_human ? 'needs_review' : 'auto_approved') as Status, request: r, items, verdict };
    const at = new Date().toISOString();
    db.prepare('INSERT INTO proposals VALUES (?,?,?,?,?,?,?,?,?)').run(
      p.id, a.customer, p.status, JSON.stringify(r), JSON.stringify(items), JSON.stringify(verdict), `${a.role}:${a.name}`, at, at);
    audit(p.id, a, 'created', { request: r, items });
    audit(p.id, a, 'policy_verdict', { status: p.status, ...verdict });
    return c.json(view(load(p.id, a)), 200);
  });

  app.openapi(route('get', '/proposals', 'Latest proposals of the caller\'s customer'), (c) => {
    const rows = db.prepare('SELECT * FROM proposals WHERE customer = ? ORDER BY created_at DESC LIMIT 100').all(c.get('actor').customer) as any[];
    return c.json(rows.map((r) => {
      const v = JSON.parse(r.verdict), req = JSON.parse(r.request);
      return { id: r.id, status: r.status, site: req.site, deliver_by: req.deliver_by, total_cents: v.total_cents,
        requires_human: v.requires_human, needs: req.items.map((i: any) => `${i.quantity} ${i.unit} ${i.need}`), created_by: r.created_by, created_at: r.created_at };
    }), 200);
  });

  app.openapi(route('get', '/proposals/{id}', 'Proposal with lines, alternatives, exceptions and verdict', { params: IdParam }), (c) => {
    const p = load(c.req.valid('param').id, c.get('actor'));
    return p ? c.json(view(p), 200) : c.json({ error: 'no such proposal' }, 404);
  });

  app.openapi(route('patch', '/proposals/{id}', 'Revise one item: quantity, a chosen option, or confirmed amounts only', {
    params: IdParam, ...body(Revision),
  }), async (c) => {
    const a = c.get('actor');
    const p = load(c.req.valid('param').id, a);
    if (!p) return c.json({ error: 'no such proposal' }, 404);
    if (!['needs_review', 'auto_approved'].includes(p.status)) return c.json({ error: `cannot revise a ${p.status} proposal` }, 409);
    const rev = c.req.valid('json');
    if (rev.item >= p.items.length) return c.json({ error: `item must be 0..${p.items.length - 1}` }, 400);
    if (rev.choose && !p.items[rev.item].options.some((o: any) => o.id === rev.choose))
      return c.json({ error: 'choose one of the listed options for this item' }, 400);
    if (rev.quantity) p.request.items[rev.item].quantity = rev.quantity;
    p.items[rev.item] = await plan(p.request, rev.item, { choose: rev.choose, confirmed_only: rev.confirmed_only });
    p.verdict = verdictFor(p.request, p.items, a);
    p.status = p.verdict.requires_human ? 'needs_review' : 'auto_approved';
    save(p);
    audit(p.id, a, 'revised', { revision: rev, item: p.items[rev.item] });
    audit(p.id, a, 'policy_verdict', { status: p.status, ...p.verdict });
    return c.json(view(load(p.id, a)), 200);
  });

  app.openapi(route('post', '/proposals/{id}/decision', 'Approve or reject (human approvers only)', {
    params: IdParam, ...body(Decision),
  }), async (c) => {
    const a = c.get('actor');
    if (a.role === 'agent') return c.json({ error: 'agents cannot approve or reject (hard rule 2); ask a human approver' }, 403);
    if (a.role !== 'approver') return c.json({ error: 'only an approver can decide' }, 403);
    const p = load(c.req.valid('param').id, a);
    if (!p) return c.json({ error: 'no such proposal' }, 404);
    if (!['needs_review', 'auto_approved'].includes(p.status)) return c.json({ error: `cannot decide a ${p.status} proposal` }, 409);
    const { decision, note } = c.req.valid('json');
    if (decision === 'reject') {
      p.status = 'rejected'; save(p); audit(p.id, a, 'rejected', { note });
      return c.json(view(load(p.id, a)), 200);
    }
    // §7.3: re-check the chosen lines before approval; any change sends it back with the difference.
    const diffs: { id: string; what: string; before: unknown; after: unknown }[] = [];
    let expired = false;
    for (const it of p.items) {
      if (!it.allocation.length) continue;
      const { offers } = await checkOffers(db, it.allocation.map((l: any) => l.id), p.request.deliver_by);
      it.allocation.forEach((l: any, i: number) => {
        const now = offers[i], before = it.options.find((o: any) => o.id === l.id).offer;
        if (now.price_cents !== before.price_cents) diffs.push({ id: l.id, what: 'price_cents', before: before.price_cents, after: now.price_cents });
        if (now.available_date !== l.date) diffs.push({ id: l.id, what: 'available_date', before: l.date, after: now.available_date });
        if (now.exceptions.includes('E2') || (now.available_amount !== null && now.available_amount < l.sales_units))
          diffs.push({ id: l.id, what: 'available_amount', before: l.sales_units, after: now.available_amount });
        if (now.exceptions.includes('E6')) { expired = true; diffs.push({ id: l.id, what: 'cut_off', before: before.closing_time, after: 'passed' }); }
      });
    }
    if (diffs.length) {
      p.status = expired ? 'expired' : 'needs_review'; save(p);
      audit(p.id, a, 'revalidation_failed', { diffs });
      return c.json({ error: 'offers changed since the proposal was made; review the difference', diffs, proposal: view(load(p.id, a)) }, 409);
    }
    p.status = 'approved'; save(p);
    audit(p.id, a, 'approved', { note, revalidated: true });
    return c.json(view(load(p.id, a)), 200);
  });

  app.openapi(createRoute({
    method: 'get', path: '/proposals/{id}/export', summary: 'Webshop import file (CSV) for an approved proposal',
    security: [{ bearer: [] }], request: { params: IdParam },
    responses: { ...responses, 200: { description: 'CSV, ; separated, decimal comma', content: { 'text/csv': { schema: z.string() } } } },
  }), (c) => {
    const a = c.get('actor');
    const p = load(c.req.valid('param').id, a);
    if (!p) return c.json({ error: 'no such proposal' }, 404);
    if (a.role === 'agent' && p.status !== 'auto_approved')
      return c.json({ error: 'this proposal needed a human; only a human can export it (hard rule 2)' }, 403);
    if (!['approved', 'auto_approved', 'exported'].includes(p.status)) return c.json({ error: `cannot export a ${p.status} proposal` }, 409);
    const csv = toCsv(db, p.items);
    if (p.status !== 'exported') {
      p.status = 'exported'; save(p);
      audit(p.id, a, 'exported', { format: 'csv', sha256: createHash('sha256').update(csv).digest('hex'), lines: csv.trim().split('\r\n').length - 1 });
    }
    return c.text(csv, 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="order-${p.id.slice(0, 8)}.csv"` });
  });

  app.openapi(route('post', '/parse', 'Free text → structured purchase request (rules; asks when ambiguous)', body(z.object({
    text: z.string().min(1).max(5000),
  }))), (c) => c.json(parseRequest(c.req.valid('json').text), 200));

  // §8.4 trust ladder: approvals in a row a human made without changing the proposal. Derived from the audit, never
  // stored; a human revision or a rejection resets it. It only suggests: the policy changes when an approver saves it.
  app.openapi(route('get', '/trust', 'Unchanged approvals in a row and a policy suggestion'), (c) => {
    const a = c.get('actor');
    const THRESHOLD = 5;
    const rows = db.prepare(
      `SELECT a.proposal, a.event, a.actor, p.verdict FROM audit a JOIN proposals p ON p.id = a.proposal
       WHERE a.customer = ? AND a.event IN ('revised', 'approved', 'rejected') ORDER BY a.seq`,
    ).all(a.customer) as any[];
    const changed = new Set<string>();
    let streak = 0, maxTotal = 0;
    for (const r of rows) {
      if (r.event === 'revised' && !r.actor.startsWith('agent:')) changed.add(r.proposal);
      else if (r.event === 'rejected' || (r.event === 'approved' && changed.has(r.proposal))) { streak = 0; maxTotal = 0; }
      else if (r.event === 'approved') { streak++; maxTotal = Math.max(maxTotal, JSON.parse(r.verdict).total_cents ?? 0); }
    }
    const policy = policyOf(a.customer);
    const limit = Math.ceil(maxTotal / 100 / 50) * 50; // round up to €50
    const suggestion = streak >= THRESHOLD && !policy.agent_may_finalise
      ? { text: `You approved ${streak} proposals in a row without changing them. Let the agent finalise orders up to €${limit}?`,
          policy: { ...policy, agent_may_finalise: true, max_order_eur: limit, max_line_eur: Math.max(policy.max_line_eur, limit) } }
      : null;
    return c.json({ streak, threshold: THRESHOLD, suggestion }, 200);
  });

  // --- policy and audit --------------------------------------------------------------------------------------------
  app.openapi(route('get', '/policy', 'Customer policy'), (c) => c.json(policyOf(c.get('actor').customer), 200));

  app.openapi(route('put', '/policy', 'Replace the customer policy (approvers only)', body(PolicySchema)), (c) => {
    const a = c.get('actor');
    if (a.role !== 'approver') return c.json({ error: 'only an approver can change the policy' }, 403);
    const before = policyOf(a.customer), after = c.req.valid('json');
    db.prepare('UPDATE customers SET policy = ? WHERE id = ?').run(JSON.stringify(after), a.customer);
    audit(null, a, 'policy_changed', { before, after });
    return c.json(after, 200);
  });

  app.openapi(route('get', '/audit', 'Decision records (append-only)', { query: z.object({ proposal: z.string().optional() }) }), (c) => {
    const a = c.get('actor'), { proposal } = c.req.valid('query');
    const rows = db.prepare(`SELECT seq, proposal, at, actor, event, data FROM audit WHERE customer = ? ${proposal ? 'AND proposal = ?' : ''} ORDER BY seq`)
      .all(...(proposal ? [a.customer, proposal] : [a.customer])) as any[];
    return c.json(rows.map((r) => ({ ...r, data: JSON.parse(r.data) })), 200);
  });

  return app;
}

/**
 * The order sink (§4): today a CSV for the webshop's file import, joined by GTIN (dataset ids ≠ webshop codes).
 * ponytail: column layout is a guess until the real import format is known (§15.2). A real order API becomes a
 * second sink next to this function; nothing else changes.
 */
export function toCsv(db: DatabaseSync, items: any[]) {
  const cell = (v: unknown) => { const s = String(v ?? ''); return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const dec = (n: number) => String(+n.toFixed(3)).replace('.', ','); // Finnish Excel: ; separator, decimal comma
  const rows = [['gtin', 'product_id', 'name', 'quantity', 'sales_unit', 'unit_price_eur', 'line_total_eur', 'delivery_date']];
  for (const it of items) for (const l of it.allocation) {
    const price = it.options.find((o: any) => o.id === l.id)?.offer.price_cents;
    rows.push([getProduct(db, l.id)?.gtin ?? '', l.id, l.name, dec(l.sales_units), l.sales_unit, dec(price / 100), dec(l.cost_cents / 100), l.date]);
  }
  return '\ufeff' + rows.map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';
}

if (import.meta.main) {
  const db = openDb();
  seed(db);
  const api = createApp(db);
  // One process for the demo: the built UI (npm run ui:build) at /, the API at /api for the UI and at / for agents.
  const web = new Hono().route('/api', api).use('/*', serveStatic({ root: 'ui/dist' })).route('/', api);
  const port = Number(process.env.PORT ?? 8787);
  serve({ fetch: web.fetch, port });
  console.log(`gateway on http://localhost:${port} (UI at /, OpenAPI at /openapi.json)${process.env.DEMO_NOW ? `, clock fixed at ${process.env.DEMO_NOW}` : ''}`);
}
