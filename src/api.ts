// Gateway: REST + OpenAPI (context.md §5). MCP tools wrap the same functions. Run: `npm start`.
import { OpenAPIHono, createRoute, z, type RouteConfig } from '@hono/zod-openapi';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.ts';
import { search, getProduct } from './catalogue.ts';
import { checkOffers, now } from './offers.ts';
import { planItem, PRESETS, type Overrides, type Priorities } from './planner.ts';
import { evaluate, effectivePolicy, historyKey, PolicySchema, type Policy, type Verdict } from './policy.ts';
import { detectLimits, parseText, readBack } from './parse.ts';
import { loadRecipes, scaleRecipe } from './recipes.ts';
import { assess, LOW_DAYS, stockOf, SYSTEM } from './stock.ts';

// One person (the owner) may do everything; the agent is the AI working through MCP and can never approve (hard rule 2).
type Role = 'owner' | 'agent';
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
    product: z.string().max(20).optional().openapi({ description: 'A product id to prefer when it is deliverable and meets the limits' }),
  })).min(1).max(30),
  exclude_allergens: z.array(z.string().regex(/^[A-Z]{2}$/)).default([]).openapi({ description: 'GS1 allergen codes, e.g. AM milk, AW gluten' }),
  diets: z.array(Diet).default([]),
  labels_required: z.array(z.string().max(80)).default([]),
  priorities: z.enum(Object.keys(PRESETS) as [Priorities, ...Priorities[]]).default('price_and_availability'),
  budget_eur: z.number().positive().nullable().default(null),
  source_text: z.string().max(5000).optional(),
}).openapi('PurchaseRequest');
// `recipe` is set only by POST /recipes/{id}/plan: where each item's quantity came from (the read-back for recipes).
type RecipeRef = {
  id: string; name: string; url: string; yield: number; portions: number; pantry?: string[];
  from: string[]; skipped: { text: string; reason: string }[];
};
// `stock` is set only by POST /stock/check: the reading the agent ordered from (the read-back for stock refills).
type StockRef = { system: string; read_at: string; name: string; on_hand: number; daily_use: number; par: number; days_left: number; incoming: number };
// `confirmed`: a person said "this is what I meant" (POST /proposals/{id}/confirm). Cleared when the request is corrected.
// `from_agent`: created by an agent key, so the original text is required for the quantity check (policy.ts).
type Request = z.infer<typeof PurchaseRequest> & {
  deliver_by: string; deliver_by_defaulted?: boolean; recipe?: RecipeRef; stock?: StockRef; confirmed?: { by: string; at: string }; from_agent?: boolean;
};
const TRUST_THRESHOLD = 3; // unchanged approvals in a row: suggest autonomy (§8.4) and skip the request confirmation

const Correction = z.object({
  items: PurchaseRequest.shape.items.optional(),
  deliver_by: DateStr.optional(),
  diets: z.array(Diet).optional(),
  exclude_allergens: z.array(z.string().regex(/^[A-Z]{2}$/)).optional(),
  priorities: z.enum(Object.keys(PRESETS) as [Priorities, ...Priorities[]]).optional(),
  portions: z.number().int().min(1).max(5000).optional().openapi({ description: 'Recipe proposals: scale the recipe again' }),
}).openapi('Correction');

const Revision = z.object({
  item: z.number().int().min(0),
  quantity: z.number().positive().max(1_000_000).optional(),
  choose: z.string().optional().openapi({ description: 'Product id from this item\'s options' }),
  confirmed_only: z.boolean().optional().openapi({ description: 'Allocate only from options with a confirmed amount' }),
}).openapi('Revision');
const Decision = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(1000).optional() }).openapi('Decision');

// Fixed demo tokens for the fictional customer: local demo, tests, Claude Desktop. Anyone can guess them, so a hosted
// server (HOSTED=1, `npm run host`) switches them off; people there register and get kitchens of their own.
export function seed(db: DatabaseSync) {
  db.exec(`
    INSERT OR IGNORE INTO customers (id, name) VALUES ('kaisla', 'Hotel Kaisla');
    INSERT OR IGNORE INTO tokens (token, customer, name, role) VALUES
      ('demo-owner', 'kaisla', 'Owner', 'owner'),
      ('demo-agent', 'kaisla', 'Buyer agent', 'agent');`);
  db.prepare("UPDATE tokens SET revoked = ? WHERE token IN ('demo-owner', 'demo-agent')").run(process.env.HOSTED ? 1 : 0);
}

/**
 * Two small milk orders the owner approved unchanged "in earlier weeks", sure-delivery option taken: the third
 * approval, made live, earns the trust-ladder suggestion (§8.4). Demo fixture for `npm run demo:reset` and for every
 * kitchen registered in the app. Needs the demo clock (DEMO_NOW) for its fixed delivery date.
 */
export async function seedHistory(app: { request: Hono['request'] }, owner: string, agent: string) {
  const call = async (token: string, method: string, path: string, body: unknown = {}) => {
    const res = await app.request(path, { method, body: JSON.stringify(body), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
    const j = (await res.json()) as any;
    if (!res.ok) throw new Error(`${path}: ${res.status} ${j.error}`);
    return j;
  };
  const done: any[] = [];
  for (const litres of [180, 200]) {
    const p = await call(agent, 'POST', '/proposals', {
      site: 'Hotel Kaisla Helsinki', deliver_by: '2026-11-16', items: [{ need: 'maito', quantity: litres, unit: 'l' }], diets: ['lactose_free'],
      source_text: `${litres} l lactose-free milk by Monday`,
    });
    await call(owner, 'PATCH', `/proposals/${p.id}`, { item: 0, confirmed_only: true }); // the agent's own offer: not a fix
    await call(owner, 'POST', `/proposals/${p.id}/confirm`); // "this is what I meant"
    done.push(await call(owner, 'POST', `/proposals/${p.id}/decision`, { decision: 'approve', note: 'routine weekly order' }));
  }
  return done;
}

// Passwords: scrypt from node:crypto, a random salt per user. Sessions are ordinary owner tokens (table `tokens`).
const hashOf = (password: string, salt: string) => scryptSync(password, salt, 32);
const newToken = () => randomBytes(24).toString('base64url');

const helsinkiToday = () => now().toLocaleDateString('en-CA', { timeZone: 'Europe/Helsinki' });
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

const json = (description: string) => ({ description, content: { 'application/json': { schema: z.any() } } });
const responses = {
  200: json('OK'), 400: json('Invalid request, or a clarification is needed'), 401: json('Missing or unknown token'),
  403: json('Not allowed for an agent'), 404: json('Not found'), 409: json('Conflicts with the current state'),
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
  app.doc31('/openapi.json', { openapi: '3.1.0', info: { title: 'Earnest gateway', version: '0.1.0' } });
  app.onError((e, c) => c.json({ error: (e as Error).message }, 500));

  // Open without a token: the OpenAPI document, and signing up / in (the app is mounted at / and at /api).
  app.use('*', async (c, next) => {
    if (/\/(openapi\.json|auth\/(config|register|login))$/.test(c.req.path)) return next();
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
    needs_review: 'A person must review and approve this proposal. Agents cannot approve.',
    auto_approved: 'Every policy rule passed: the agent may export it. A human can still reject it until export.',
    approved: 'Approved by a human. Ready for export.',
    rejected: 'Rejected. Nothing will be ordered.', expired: 'Expired: an order cut-off passed. Create a new proposal.',
    exported: 'Exported for webshop import.',
  };
  // Unchanged human approvals in a row, newest streak only (§8.4). A human revision, correction or rejection ends it.
  const streakOf = (customer: string): Verdict[] => {
    const rows = db.prepare(
      `SELECT a.proposal, a.event, a.actor, a.data, p.verdict FROM audit a JOIN proposals p ON p.id = a.proposal
       WHERE a.customer = ? AND a.event IN ('revised', 'request_corrected', 'approved', 'rejected') ORDER BY a.seq`,
    ).all(customer) as any[];
    const changed = new Set<string>();
    let streak: Verdict[] = [];
    for (const r of rows) {
      // Taking the sure-delivery option the agent itself offered is a choice between its plans, not a fix of them.
      const tookOffer = r.event === 'revised' && (({ item, ...rest }) => JSON.stringify(rest) === '{"confirmed_only":true}')(JSON.parse(r.data).revision ?? {});
      if (['revised', 'request_corrected'].includes(r.event) && !r.actor.startsWith('agent:') && !tookOffer) changed.add(r.proposal);
      else if (r.event === 'rejected' || (r.event === 'approved' && changed.has(r.proposal))) streak = [];
      else if (r.event === 'approved') streak.push(JSON.parse(r.verdict));
    }
    return streak;
  };
  // A person confirms the request was understood before approving, until they have approved enough without fixes.
  const confirmationOf = (p: any) => {
    const trusted = streakOf(p.customer).length >= TRUST_THRESHOLD;
    return { required: p.status === 'needs_review' && !trusted && !p.request.confirmed, done: p.request.confirmed ?? null,
      skipped_by_trust: trusted && !p.request.confirmed, threshold: TRUST_THRESHOLD };
  };
  const view = (p: any) => ({
    id: p.id, status: p.status, confirmation: confirmationOf(p), site: p.request.site, deliver_by: p.request.deliver_by,
    deliver_by_defaulted: !!p.request.deliver_by_defaulted, total_cents: p.verdict.total_cents,
    requires_human: p.verdict.requires_human, next: NEXT[p.status as Status], policy_verdict: p.verdict,
    // Full excluded lists stay in the audit record; responses carry the first 20 so agents' context stays small.
    items: p.items.map((it: any) => ({ ...it, excluded: it.excluded.slice(0, 20), excluded_total: it.excluded.length })),
    request: p.request, read_back: readBack(p.request), created_by: p.created_by, created_at: p.created_at, updated_at: p.updated_at,
  });

  // Plan one item; options keep their offers and scores (decision record), drop the bulky product records.
  const plan = async (r: Request, i: number, overrides: Overrides = {}) => {
    const limits = { exclude_allergens: r.exclude_allergens, diets: r.diets, labels_required: r.labels_required };
    const res = await planItem(db, r.items[i], limits, r.deliver_by, r.priorities, overrides);
    return { ...res, options: res.options.map(({ product, ...o }) => o) };
  };
  // Quantities the customer approved before (last 50 approved proposals), for the usual_quantity rule.
  const historyOf = (customer: string) => {
    const h = new Map<string, number[]>();
    const rows = db.prepare(`SELECT items FROM proposals WHERE customer = ? AND status IN ('approved', 'exported') ORDER BY created_at DESC LIMIT 50`).all(customer) as any[];
    for (const r of rows) for (const it of JSON.parse(r.items)) h.set(historyKey(it), [...(h.get(historyKey(it)) ?? []), it.item.quantity]);
    return h;
  };
  const verdictFor = (r: Request, items: any[], a: Actor) =>
    // Recipes and stock refills: the gateway computed the quantities, not a model reading words, so there is no text to
    // check them against. usual_quantity still catches a bad stock reading (a typo in the par level).
    evaluate(db, items, { exclude_allergens: r.exclude_allergens, diets: r.diets, labels_required: r.labels_required, budget_eur: r.budget_eur, source_text: r.source_text, from_agent: r.from_agent && !r.recipe && !r.stock },
      effectivePolicy(policyOf(a.customer), a.role === 'agent' ? a.limits : null), historyOf(a.customer));

  // --- accounts: each person who registers gets a kitchen of their own --------------------------------------------
  const Credentials = z.object({ email: z.email().max(200), password: z.string().min(8).max(200) });
  const open = <R extends RouteConfig['request']>(method: 'get' | 'post', path: string, summary: string, request?: R) =>
    createRoute({ method, path, summary, request: request as R, responses });
  app.openapi(open('get', '/auth/config', 'What the sign-up form needs (no token)'), (c) =>
    c.json({ invite_required: !!process.env.INVITE_CODE, demo_kitchen: !process.env.HOSTED }, 200));

  app.openapi(open('post', '/auth/register', 'Create an account with its own demo kitchen; the invite code when the server sets one (no token)',
    body(Credentials.extend({ name: z.string().trim().min(1).max(100), invite: z.string().max(200).optional() }))), async (c) => {
    const { email, password, name, invite } = c.req.valid('json');
    // ponytail: one shared invite code, no rate limit. Enough to keep strangers off the team's API keys for a weekend.
    if (process.env.INVITE_CODE && invite?.trim() !== process.env.INVITE_CODE) return c.json({ error: 'That invite code is not right.' }, 403);
    const mail = email.toLowerCase();
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(mail)) return c.json({ error: 'An account with this email exists. Sign in instead.' }, 409);
    const customer = randomUUID(), salt = randomBytes(16).toString('hex'), owner = newToken(), agent = newToken();
    db.prepare('INSERT INTO customers (id, name) VALUES (?, ?)').run(customer, 'Hotel Kaisla');
    db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run(mail, customer, name, salt, hashOf(password, salt).toString('hex'), new Date().toISOString());
    db.prepare(`INSERT INTO tokens (token, customer, name, role) VALUES (?, ?, ?, 'owner'), (?, ?, 'Buyer agent', 'agent')`).run(owner, customer, name, agent, customer);
    // The same starting point as the demo: two approved milk orders, so the third approval earns trust.
    let history = 0;
    try { history = (await seedHistory(app, owner, agent)).length; } catch (e) { console.error(`history for a new kitchen: ${(e as Error).message}`); }
    return c.json({ token: owner, name, history }, 200);
  });

  app.openapi(open('post', '/auth/login', 'Sign in; returns a session token (no token)', body(Credentials)), (c) => {
    const { email, password } = c.req.valid('json');
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase()) as any;
    if (!u || !timingSafeEqual(hashOf(password, u.salt), Buffer.from(u.hash, 'hex'))) return c.json({ error: 'Email or password is not right.' }, 401);
    const token = newToken();
    db.prepare(`INSERT INTO tokens (token, customer, name, role) VALUES (?, ?, ?, 'owner')`).run(token, u.customer, u.name);
    return c.json({ token, name: u.name }, 200);
  });

  app.openapi(route('post', '/auth/logout', 'End this session'), (c) => {
    if (c.get('actor').role !== 'owner') return c.json({ error: 'agent keys are revoked by the owner, not signed out' }, 403);
    // Sessions of registered accounts only: signing out of the shared demo kitchen must not lock everyone out of it.
    db.prepare('UPDATE tokens SET revoked = 1 WHERE token = ? AND customer IN (SELECT customer FROM users)').run(c.req.header('authorization')!.replace(/^Bearer /i, ''));
    return c.json({ ok: true }, 200);
  });

  app.openapi(route('get', '/me', 'Who is signed in, and which kitchen'), (c) => {
    const a = c.get('actor');
    const u = db.prepare('SELECT email FROM users WHERE customer = ?').get(a.customer) as any;
    const k = db.prepare('SELECT name FROM customers WHERE id = ?').get(a.customer) as any;
    return c.json({ name: a.name, role: a.role, email: u?.email ?? null, kitchen: k.name }, 200);
  });

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
  // Every way in (free text, form, agent, recipe) ends here: same limits, planning, policy and decision record.
  // Request + planned items + verdict: shared by creating a proposal and correcting one.
  const planRequest = async (a: Actor, input: z.infer<typeof PurchaseRequest> & { stock?: StockRef }, recipe?: RecipeRef, fromAgent = a.role === 'agent') => {
    const today = helsinkiToday();
    if (input.deliver_by && input.deliver_by < today)
      return { error: 'clarification needed', question: `The delivery date ${input.deliver_by} is in the past. Which date do you need?` };
    // §6: limits the keyword detector finds in the source text are always added; an agent cannot drop them.
    const found = detectLimits(input.source_text ?? '');
    const r: Request = {
      ...input, deliver_by: input.deliver_by ?? addDays(today, 1), deliver_by_defaulted: !input.deliver_by,
      diets: [...new Set([...input.diets, ...found.diets])], exclude_allergens: [...new Set([...input.exclude_allergens, ...found.exclude_allergens])],
      ...(recipe ? { recipe } : {}), ...(fromAgent ? { from_agent: true } : {}),
    };
    // Three items at a time: a recipe has up to ten, one by one with the model takes half a minute. 429s are retried.
    const planAll = async () => {
      const items: any[] = new Array(r.items.length);
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(3, r.items.length) }, async () => {
        while (next < r.items.length) { const i = next++; items[i] = await plan(r, i); }
      }));
      return items;
    };
    let items = await planAll();
    // §6: no date given → the first date every item can still be ordered for (options with a passed cut-off are
    // already dropped), not blindly "tomorrow". One more round of offers, only when tomorrow turns out too early.
    if (r.deliver_by_defaulted) {
      const first = items.map((it) => it.options.map((o: any) => o.offer.available_date).filter(Boolean).sort()[0]).filter(Boolean).sort().at(-1);
      if (first && first > r.deliver_by) { r.deliver_by = first; items = await planAll(); }
    }
    return { r, items, verdict: verdictFor(r, items, a) };
  };
  const createProposal = async (a: Actor, input: z.infer<typeof PurchaseRequest> & { stock?: StockRef }, recipe?: RecipeRef) => {
    const planned = await planRequest(a, input, recipe);
    if ('question' in planned) return planned;
    let { r, items, verdict } = planned;
    // Finishing alone, the agent does not take unconfirmed stock unless the policy accepts it: it switches to the
    // sure-delivery option and keeps it only if that passes every check. Otherwise the person sees the best option with
    // the sure one next to it. Same for a request typed in the app: the planner is the agent there too.
    const pol = effectivePolicy(policyOf(a.customer), a.role === 'agent' ? a.limits : null);
    if (pol.agent_may_finalise && verdict.requires_human && items.some((it) => it.sure_option)) {
      const sure = await Promise.all(items.map((it, i) => (it.sure_option ? plan(r, i, { confirmed_only: true }) : it)));
      const v = verdictFor(r, sure, a);
      if (!v.requires_human) { items = sure; verdict = v; }
    }
    const p = { id: randomUUID(), status: (verdict.requires_human ? 'needs_review' : 'auto_approved') as Status, request: r, items, verdict };
    const at = new Date().toISOString();
    db.prepare('INSERT INTO proposals VALUES (?,?,?,?,?,?,?,?,?)').run(
      p.id, a.customer, p.status, JSON.stringify(r), JSON.stringify(items), JSON.stringify(verdict), `${a.role}:${a.name}`, at, at);
    audit(p.id, a, 'created', { request: r, items });
    audit(p.id, a, 'policy_verdict', { status: p.status, ...verdict });
    return view(load(p.id, a));
  };
  app.openapi(route('post', '/proposals', 'Plan a purchase request into a proposal with a policy verdict', body(PurchaseRequest)), async (c) => {
    const out = await createProposal(c.get('actor'), c.req.valid('json'));
    return 'question' in out ? c.json(out, 400) : c.json(out, 200);
  });

  // --- recipes (Valio Aimo professional-kitchen recipes, data/recipes.json) ----------------------------------------
  const RecipeId = z.object({ id: z.string() });
  app.openapi(route('get', '/recipes', 'Recipes to plan an order from'), (c) =>
    c.json(loadRecipes().map(({ lines, ...r }) => ({ ...r, ingredients: lines.length })), 200));
  app.openapi(route('get', '/recipes/{id}', 'One recipe with its ingredient lines', { params: RecipeId }), (c) => {
    const r = loadRecipes().find((x) => x.id === c.req.valid('param').id);
    return r ? c.json(r, 200) : c.json({ error: 'no such recipe' }, 404);
  });
  app.openapi(route('post', '/recipes/{id}/plan', 'Scale a recipe to N portions and plan its ingredients into a proposal', {
    params: RecipeId, ...body(z.object({
      portions: z.number().int().min(1).max(5000),
      site: z.string().min(1).max(200).default('Hotel Kaisla Helsinki'),
      deliver_by: DateStr.optional(),
      pantry: z.array(z.string().max(100)).default([]).openapi({ description: 'Usually-in-stock ingredients to buy anyway (their need names)' }),
      exclude_allergens: z.array(z.string().regex(/^[A-Z]{2}$/)).default([]),
      diets: z.array(Diet).default([]),
      priorities: z.enum(Object.keys(PRESETS) as [Priorities, ...Priorities[]]).default('price_and_availability'),
    })),
  }), async (c) => {
    const recipe = loadRecipes().find((x) => x.id === c.req.valid('param').id);
    if (!recipe) return c.json({ error: 'no such recipe' }, 404);
    const { portions, pantry, ...rest } = c.req.valid('json');
    const scaled = scaleRecipe(recipe, portions, pantry);
    if (!scaled.items.length) return c.json({ error: 'clarification needed', question: 'Nothing to buy for this recipe. Include the usually-in-stock items?' }, 400);
    const out = await createProposal(c.get('actor'), {
      ...rest, labels_required: [], budget_eur: null,
      items: scaled.items.map(({ need, quantity, unit, product }) => ({ need, quantity, unit, ...(product ? { product } : {}) })),
    }, { id: recipe.id, name: recipe.name, url: recipe.url, yield: recipe.yield, portions, pantry, from: scaled.items.map((i) => i.from), skipped: scaled.skipped });
    return 'question' in out ? c.json(out, 400) : c.json(out, 200);
  });

  // --- the kitchen's stock system (mock, src/stock.ts) ---------------------------------------------------------------
  // Amounts already on the way: open orders the agent made from the stock system, so a second check does not repeat them.
  const stockNow = (customer: string) => {
    const s = stockOf(customer);
    if (!s) return null;
    const open = (db.prepare(`SELECT id, request FROM proposals WHERE customer = ? AND status NOT IN ('rejected', 'expired')`).all(customer) as any[])
      .map((r) => ({ id: r.id as string, req: JSON.parse(r.request) as Request })).filter((r) => r.req.stock);
    const today = helsinkiToday();
    return { system: SYSTEM, site: s.site, read_at: now().toISOString(), low_days: LOW_DAYS, items: s.items.map((it) => {
      const mine = open.filter((o) => o.req.items.some((x) => x.need === it.need && x.unit === it.unit));
      const incoming = mine.reduce((n, o) => n + o.req.items.filter((x) => x.need === it.need && x.unit === it.unit).reduce((m, x) => m + x.quantity, 0), 0);
      return { ...assess(it, incoming, today), orders: mine.map((o) => o.id) };
    }) };
  };
  app.openapi(route('get', '/stock', 'The kitchen\'s stock levels and what runs low (read from its stock system)'), (c) => {
    const s = stockNow(c.get('actor').customer);
    return s ? c.json(s, 200) : c.json({ error: 'no stock system connected' }, 404);
  });
  app.openapi(route('post', '/stock/check', 'The agent reads the stock system and proposes a refill for everything running low'), async (c) => {
    const a = c.get('actor');
    const s = stockNow(a.customer);
    if (!s) return c.json({ error: 'no stock system connected' }, 404);
    // A person may ask, but the agent does the work under its own key and limits: the proposals are the agent's.
    const t = db.prepare(`SELECT t.name, t.limits, c.agents_enabled FROM tokens t JOIN customers c ON c.id = t.customer
      WHERE t.customer = ? AND t.role = 'agent' AND NOT t.revoked`).get(a.customer) as any;
    if (!t) return c.json({ error: 'this customer has no agent key' }, 409);
    if (!t.agents_enabled) return c.json({ error: 'agents are switched off for this customer' }, 403);
    const agent: Actor = { customer: a.customer, name: t.name, role: 'agent', limits: t.limits ? JSON.parse(t.limits) : null };
    // One proposal per product: routine refills can finish on their own while new ones wait for a person.
    const created = await Promise.all(s.items.filter((it) => it.low && it.order > 0).map((it) => createProposal(agent, {
      site: s.site, deliver_by: it.deliver_by, items: [{ need: it.need, quantity: it.order, unit: it.unit }],
      diets: it.diets, exclude_allergens: [], labels_required: [], priorities: 'price_and_availability', budget_eur: null,
      stock: { system: s.system, read_at: s.read_at, name: it.name, on_hand: it.on_hand, daily_use: it.daily_use, par: it.par, days_left: it.days_left, incoming: it.incoming },
    })));
    return c.json({ checked: s.items.length, created }, 200);
  });

  app.openapi(route('get', '/proposals', 'Latest proposals of the caller\'s customer'), (c) => {
    const rows = db.prepare('SELECT * FROM proposals WHERE customer = ? ORDER BY created_at DESC LIMIT 100').all(c.get('actor').customer) as any[];
    return c.json(rows.map((r) => {
      const v = JSON.parse(r.verdict), req = JSON.parse(r.request);
      return { id: r.id, status: r.status, site: req.site, deliver_by: req.deliver_by, total_cents: v.total_cents,
        requires_human: v.requires_human, open_checks: v.rules.filter((x: any) => !x.ok).map((x: any) => x.rule), recipe: req.recipe ? `${req.recipe.name} × ${req.recipe.portions} portions` : null, from_stock: !!req.stock, needs: req.items.map((i: any) => `${i.quantity} ${i.unit} ${i.need}`), created_by: r.created_by, created_at: r.created_at };
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

  app.openapi(route('post', '/proposals/{id}/confirm', 'A person confirms the request was understood as meant (people only)', { params: IdParam }), (c) => {
    const a = c.get('actor');
    if (a.role === 'agent') return c.json({ error: 'only a person can confirm what they meant' }, 403);
    const p = load(c.req.valid('param').id, a);
    if (!p) return c.json({ error: 'no such proposal' }, 404);
    if (!['needs_review', 'auto_approved'].includes(p.status)) return c.json({ error: `cannot confirm a ${p.status} proposal` }, 409);
    p.request.confirmed = { by: `${a.role}:${a.name}`, at: new Date().toISOString() };
    save(p);
    audit(p.id, a, 'request_confirmed', {});
    return c.json(view(load(p.id, a)), 200);
  });

  app.openapi(route('patch', '/proposals/{id}/request', 'Correct what was asked (items, date, limits, priorities, portions) and plan again (people only)', {
    params: IdParam, ...body(Correction),
  }), async (c) => {
    const a = c.get('actor');
    if (a.role === 'agent') return c.json({ error: 'agents revise lines; correcting what was meant is for a person' }, 403);
    const p = load(c.req.valid('param').id, a);
    if (!p) return c.json({ error: 'no such proposal' }, 404);
    if (!['needs_review', 'auto_approved'].includes(p.status)) return c.json({ error: `cannot correct a ${p.status} proposal` }, 409);
    const fix = c.req.valid('json'), old = p.request;
    let items = fix.items ?? old.items, recipe = old.recipe;
    if (recipe && fix.portions) {
      const source = loadRecipes().find((x) => x.id === recipe!.id);
      if (!source) return c.json({ error: 'the recipe is no longer available' }, 409);
      const scaled = scaleRecipe(source, fix.portions, recipe.pantry ?? []);
      items = scaled.items.map(({ need, quantity, unit, product }) => ({ need, quantity, unit, ...(product ? { product } : {}) }));
      recipe = { ...recipe, portions: fix.portions, from: scaled.items.map((i) => i.from), skipped: scaled.skipped };
    }
    const planned = await planRequest(a, {
      site: old.site, source_text: old.source_text, labels_required: old.labels_required, budget_eur: old.budget_eur, items, stock: old.stock,
      deliver_by: fix.deliver_by ?? (old.deliver_by_defaulted ? undefined : old.deliver_by),
      diets: fix.diets ?? old.diets, exclude_allergens: fix.exclude_allergens ?? old.exclude_allergens, priorities: fix.priorities ?? old.priorities,
    }, recipe, !!old.from_agent);
    if ('question' in planned) return c.json(planned, 400);
    Object.assign(p, { request: planned.r, items: planned.items, verdict: planned.verdict, status: planned.verdict.requires_human ? 'needs_review' : 'auto_approved' });
    save(p);
    audit(p.id, a, 'request_corrected', { correction: fix, request: planned.r, items: planned.items });
    audit(p.id, a, 'policy_verdict', { status: p.status, ...p.verdict });
    return c.json(view(load(p.id, a)), 200);
  });

  app.openapi(route('post', '/proposals/{id}/decision', 'Approve or reject (people only, never an agent)', {
    params: IdParam, ...body(Decision),
  }), async (c) => {
    const a = c.get('actor');
    if (a.role === 'agent') return c.json({ error: 'agents cannot approve or reject (hard rule 2); a person decides in the app' }, 403);
    const p = load(c.req.valid('param').id, a);
    if (!p) return c.json({ error: 'no such proposal' }, 404);
    if (!['needs_review', 'auto_approved'].includes(p.status)) return c.json({ error: `cannot decide a ${p.status} proposal` }, 409);
    const { decision, note } = c.req.valid('json');
    if (decision === 'approve' && confirmationOf(p).required)
      return c.json({ error: 'confirm the request first: is this what was meant?', needs_confirmation: true }, 409);
    if (decision === 'reject') {
      // Trust is lost faster than it is earned: rejecting an order the agent finished alone switches autonomy off.
      if (p.status === 'auto_approved') {
        const pol = policyOf(a.customer);
        if (pol.agent_may_finalise) {
          db.prepare('UPDATE customers SET policy = ? WHERE id = ?').run(JSON.stringify({ ...pol, agent_may_finalise: false }), a.customer);
          audit(p.id, a, 'autonomy_revoked', { reason: 'a person rejected an order the agent finished alone' });
        }
      }
      p.status = 'rejected'; save(p); audit(p.id, a, 'rejected', { note });
      return c.json(view(load(p.id, a)), 200);
    }
    // §7.3: re-check the chosen lines before approval; any change sends it back with the difference.
    const diffs: { id: string; what: string; before: unknown; after: unknown }[] = [];
    let expired = false;
    const stale: string[] = []; // API trouble: the re-check ran against cached offers, and the record says so
    for (const it of p.items) {
      if (!it.allocation.length) continue;
      const { offers, errors } = await checkOffers(db, it.allocation.map((l: any) => l.id), p.request.deliver_by);
      stale.push(...errors);
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
    audit(p.id, a, 'approved', { note, revalidated: !stale.length, ...(stale.length ? { revalidation_errors: stale } : {}) });
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
  }))), async (c) => c.json(await parseText(c.req.valid('json').text), 200));

  // §8.4 trust ladder: approvals in a row a human made without changing the proposal. Derived from the audit, never
  // stored; a human revision or a rejection resets it. It only suggests: the policy changes when the owner saves it.
  app.openapi(route('get', '/trust', 'Unchanged approvals in a row and a policy suggestion'), (c) => {
    const a = c.get('actor');
    const THRESHOLD = TRUST_THRESHOLD;
    const streak = streakOf(a.customer);
    const policy = policyOf(a.customer);
    const limit = Math.ceil(Math.max(0, ...streak.map((v) => v.total_cents ?? 0)) / 100 / 50) * 50; // round up to €50
    // Learn from what the person accepted every time: a soft yes/no rule that failed in every approval of the streak.
    // Money limits come from the totals above; hard rules (allergens, quantities, …) are never loosened.
    const acceptedEvery = (rule: string) => streak.every((v) => v.rules.some((x) => x.rule === rule && !x.ok));
    const SOFT = { allow_split: 'allow_split', allow_unconfirmed_stock: 'confirmed_stock' } as const; // setting → its rule
    const learned = (Object.keys(SOFT) as (keyof typeof SOFT)[]).filter((k) => !policy[k] && acceptedEvery(SOFT[k]));
    const suggestion = streak.length >= THRESHOLD && !policy.agent_may_finalise
      ? { text: `You approved ${streak.length} proposals in a row without changing them. Let the agent finish routine orders up to €${limit} on its own`
            + `${learned.includes('allow_split') ? ', including orders split across products, as you accepted each time' : ''}`
            + `${learned.includes('allow_unconfirmed_stock') ? ', including products Valio gives no stock amount for, as you accepted each time' : ''}?`,
          learned,
          policy: { ...policy, agent_may_finalise: true, max_order_eur: limit, max_line_eur: Math.max(policy.max_line_eur, limit),
            ...Object.fromEntries(learned.map((k) => [k, true])) } }
      : null;
    return c.json({ streak: streak.length, threshold: THRESHOLD, suggestion }, 200);
  });

  // --- policy and audit --------------------------------------------------------------------------------------------
  app.openapi(route('get', '/policy', 'Customer policy'), (c) => c.json(policyOf(c.get('actor').customer), 200));

  app.openapi(route('put', '/policy', 'Replace the customer policy (people only, never an agent)', body(PolicySchema)), (c) => {
    const a = c.get('actor');
    if (a.role === 'agent') return c.json({ error: 'agents cannot change the policy' }, 403);
    const before = policyOf(a.customer), after = c.req.valid('json');
    db.prepare('UPDATE customers SET policy = ? WHERE id = ?').run(JSON.stringify(after), a.customer);
    audit(null, a, 'policy_changed', { before, after });
    return c.json(after, 200);
  });

  // Kill switch (§3): one click turns every agent key of this customer off (the auth middleware answers 403).
  const agentsOn = (customer: string) => !!(db.prepare('SELECT agents_enabled FROM customers WHERE id = ?').get(customer) as any).agents_enabled;
  app.openapi(route('get', '/agents', 'Are this customer\'s agent keys switched on?'), (c) => c.json({ enabled: agentsOn(c.get('actor').customer) }, 200));
  app.openapi(route('put', '/agents', 'Kill switch: turn all agent keys of this customer on or off (people only)', body(z.object({ enabled: z.boolean() }))), (c) => {
    const a = c.get('actor'), { enabled } = c.req.valid('json');
    if (a.role === 'agent') return c.json({ error: 'agents cannot switch agents on or off' }, 403);
    if (enabled !== agentsOn(a.customer)) {
      db.prepare('UPDATE customers SET agents_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, a.customer);
      audit(null, a, enabled ? 'agents_enabled' : 'agents_disabled', {});
    }
    return c.json({ enabled }, 200);
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
  // Hosted without an invite code, anyone with the link could sign up and spend the team's Valio and LLM keys.
  if (process.env.HOSTED && !process.env.INVITE_CODE) {
    console.error('HOSTED=1 needs INVITE_CODE: set it in .env or run `INVITE_CODE=<code> npm run host`.');
    process.exit(1);
  }
  const db = openDb();
  seed(db);
  const api = createApp(db);
  // One process for the demo: the built UI (npm run ui:build) at /, the API at /api for the UI and at / for agents.
  const web = new Hono().route('/api', api).use('/*', serveStatic({ root: 'ui/dist' })).route('/', api);
  const port = Number(process.env.PORT ?? 8787);
  serve({ fetch: web.fetch, port });
  console.log(`gateway on http://localhost:${port} (UI at /, OpenAPI at /openapi.json)${process.env.DEMO_NOW ? `, clock fixed at ${process.env.DEMO_NOW}` : ''}`);
}
