Valo Aimo Challenge — Trusted Trade Agents. Spec: [context.md](context.md).

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

## Demo

```sh
npm run record      # online, the day before: records the offers the scenes use (fallback if the API is down)
npm run demo:reset  # empty proposals + decision record, 5 approved orders of history (trust-ladder banner)
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
