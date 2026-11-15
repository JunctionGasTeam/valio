// MCP server (stdio) for any outside agent (context.md §5). A pure client of the gateway: it holds only an agent key,
// so every guardrail is enforced by the gateway, not here. There is deliberately no tool to approve or reject.
// Env: GATEWAY_URL (default http://localhost:8787), AGENT_TOKEN (default demo-agent). Gateway must be running.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { PurchaseRequest } from './api.ts';

const GATEWAY = (process.env.GATEWAY_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const TOKEN = process.env.AGENT_TOKEN ?? 'demo-agent';

async function gateway(method: string, path: string, body?: unknown) {
  try {
    const res = await fetch(GATEWAY + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    });
    return { content: [{ type: 'text' as const, text: await res.text() }], isError: !res.ok };
  } catch (e) {
    return { content: [{ type: 'text' as const, text: `gateway unreachable at ${GATEWAY}: ${(e as Error).message}` }], isError: true };
  }
}

const AFTER = 'The response carries `requires_human` and `next`: tell your user exactly what happens next. '
  + 'You cannot approve; a person signs off in the app unless the policy lets the proposal finalise automatically.';

const server = new McpServer({ name: 'earnest', version: '0.1.0' });
const readOnly = { readOnlyHint: true, openWorldHint: false };

server.registerTool('search_products', {
  description: 'Search the Valio Aimo catalogue (local data, no price call). Names are Finnish/English/Swedish; Finnish terms work best (maito = milk). '
    + 'Filters remove products that break diets or allergen limits; products with no allergen data are excluded whenever a limit applies.',
  inputSchema: {
    q: z.string().min(1), diets: z.array(z.enum(['lactose_free', 'gluten_free', 'vegan', 'vegetarian'])).optional(),
    exclude_allergens: z.array(z.string()).optional().describe('GS1 codes, e.g. AM milk, AW gluten, AE egg'),
    labels: z.array(z.string()).optional(), origin: z.string().optional(), limit: z.number().int().min(1).max(50).optional(),
  },
  annotations: readOnly,
}, (a) => {
  const qs = new URLSearchParams({ q: a.q });
  for (const k of ['diets', 'exclude_allergens', 'labels'] as const) if (a[k]?.length) qs.set(k, a[k]!.join(','));
  if (a.origin) qs.set('origin', a.origin);
  if (a.limit) qs.set('limit', String(a.limit));
  return gateway('GET', `/products/search?${qs}`);
});

server.registerTool('get_product', {
  description: 'Static product data: names, sales unit, pack content, allergens, diet claims, labels, CO2, delivery reliability.',
  inputSchema: { id: z.string() }, annotations: readOnly,
}, ({ id }) => gateway('GET', `/products/${encodeURIComponent(id)}`));

server.registerTool('check_offers', {
  description: 'Live price and availability from Valio for up to 50 product ids on a delivery date (YYYY-MM-DD). '
    + 'Query only a shortlist. Exception codes: E2 not deliverable, E3 late, E5 no stock amount reported (the customer policy decides whether a person must accept it), E6 cut-off passed, E7 no price, E9 API trouble.',
  inputSchema: { ids: z.array(z.string()).min(1).max(50), date: z.string() },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, (a) => gateway('POST', '/offers', a));

server.registerTool('create_proposal', {
  description: 'Turn a purchase request into an order proposal: matched products, frozen prices, quantities in sales units, '
    + 'a reason per line and a policy verdict. Always pass the person\'s own words as `source_text`: quantities are checked '
    + 'against it, and without it the proposal always waits for a person. ' + AFTER,
  inputSchema: PurchaseRequest,
}, (a) => gateway('POST', '/proposals', a));

server.registerTool('check_stock', {
  description: 'Read the kitchen\'s stock system and create a refill proposal for every product that runs out within 3 days '
    + '(refilled to the kitchen\'s par level, one proposal per product; products already on the way are skipped). ' + AFTER,
  inputSchema: {},
}, () => gateway('POST', '/stock/check', {}));

server.registerTool('get_proposal', {
  description: 'A proposal with its lines, alternatives, exceptions, status and policy verdict. ' + AFTER,
  inputSchema: { id: z.string() }, annotations: readOnly,
}, ({ id }) => gateway('GET', `/proposals/${encodeURIComponent(id)}`));

server.registerTool('revise_proposal', {
  description: 'Change one item of an open proposal: a new quantity, one chosen option (product id from that item\'s options), '
    + 'or confirmed_only to allocate only from options with a confirmed amount. Re-runs all checks and the policy. ' + AFTER,
  inputSchema: {
    id: z.string(), item: z.number().int().min(0), quantity: z.number().positive().optional(),
    choose: z.string().optional(), confirmed_only: z.boolean().optional(),
  },
}, ({ id, ...rev }) => gateway('PATCH', `/proposals/${encodeURIComponent(id)}`, rev));

server.registerTool('export_proposal', {
  description: 'Webshop import file (CSV, GTIN per line) for a proposal the policy auto-approved. '
    + 'Proposals that needed a human can only be exported by a human.',
  inputSchema: { id: z.string() },
}, ({ id }) => gateway('GET', `/proposals/${encodeURIComponent(id)}/export`));

await server.connect(new StdioServerTransport());
