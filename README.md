# Trusted Trade Agents

Valio Aimo challenge, Junction 2026. An open gateway (MCP + REST/OpenAPI) that lets any AI purchasing agent buy food from Valio Aimo: it turns a request ("1,000 litres of lactose-free milk by Monday") into an order proposal with real products, fixed prices, sales units and a reason per line. A policy in the gateway, not in the agent, decides whether the agent may finish the order or a person signs off. Full spec: [context.md](context.md).

| Brief | Where |
|---|---|
| Lookup | Local full-text search over the product data, then one price and one availability call for a shortlist of ≤ 50 (`src/catalogue.ts`, `src/offers.ts`) |
| Request and order | Free text, form, recipe or an outside agent → the same planner; prices frozen and re-checked at approval; CSV order file by GTIN (`src/planner.ts`, `src/api.ts`) |
| Permissions and approval | Agents can never approve; hard rules no setting changes; owner policy, kill switch, trust ladder (`src/policy.ts`) |
| More than price | Delivery reliability, CO2 and origin in the score |
| Exceptions | E1–E9: no match, not deliverable, late, partial, unknown amount, cut-off passed, no price, allergen data missing, API trouble |
| Explain decisions | Reason per line, read-back of the request, append-only decision record (`GET /audit`) |

Known limits: no order API exists, so the result is an approved order file (its column layout is not yet confirmed against the webshop import); demo tokens are fixed strings.

## Run

Node ≥ 23.6 (runs `.ts` directly). Dataset files go in `data/` (not in git, licence: Junction 2026 only). Copy `.env.example` to `.env` and fill it.

```sh
npm install
npm run db      # data/valio.db from the dataset (keeps the recorded offer cache)
npm run recipes # online, once: 15 Valio Aimo recipes → data/recipes.json (Recipes page)
npm test
npm start       # gateway on :8787, OpenAPI at /openapi.json
npm run ui      # approval UI on :5173 (proxies /api to the gateway)
```

Optional: `GEMINI_API_KEY` in `.env` turns on the model (parsing free text, checking the product type of search hits). Without it everything runs on rules.

Demo tokens (`Authorization: Bearer …`): `demo-owner` (the one person using the app: may do everything) and `demo-agent` (the AI agent over MCP: never approves, never changes the policy). Set `DEMO_NOW` to fix the clock.

Kitchen stock (Stock page, `GET /stock`, MCP `check_stock`) reads a mock of the kitchen's own stock system (`src/stock.ts`); the agent proposes a refill for whatever runs out within 3 days.

## Demo

```sh
npm run record      # online, the day before: records the offers the scenes use (fallback if the API is down)
npm run demo:reset  # empty proposals + decision record, 2 approved orders of history (the 3rd, live, brings the trust banner)
npm run demo        # builds the UI, one process on :8787 (UI at /), clock fixed at 2026-11-14 12:00
```

Scenes: context.md §11.2. Set `VALIO_TIMEOUT_MS=2000` if the venue network is slow: the gateway then falls back to the cache sooner and says so.

## Claude Desktop (MCP)

Start the gateway, then add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "valio-aimo": {
      "command": "node",
      "args": ["--disable-warning=ExperimentalWarning", "/ABSOLUTE/PATH/TO/valio/src/mcp.ts"],
      "env": { "GATEWAY_URL": "http://localhost:8787", "AGENT_TOKEN": "demo-agent" }
    }
  }
}
```

If Claude Desktop cannot find `node`, use the full path from `which node` as `command`.

The agent can search, check offers, create and revise proposals. It cannot approve: that is a human step.
