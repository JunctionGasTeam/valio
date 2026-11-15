# Earnest

**A trusted purchasing agent for Valio Aimo. Trust isn't given. It's earned.**

Try it: sign up with the invite code `gasteamInvite`.

## The problem

Ordering is moving from people clicking through a webshop to AI agents buying for them. Valio Aimo serves 20,000+ professional kitchens with 25,000 products from 700 suppliers. An agent can already look up products and build an order. The hard part is the last step: when do you let it approve on its own, and what stops it when it shouldn't?

## What Earnest does

You say what the kitchen needs ("200 litres of lactose-free milk by Monday"). Earnest returns a ready-to-approve order: real products, fixed prices, real sales units, a delivery date and a reason for every line. A policy decides whether the agent may finish the order or a person must sign off.

## Problems we solved

**1. When can an agent be trusted to order alone?**
A trust ladder. On day one a person approves every order. After three approvals in a row without changes, the system suggests a limit ("routine orders up to €500"); the owner grants it, the agent never takes it. From then on routine orders finish without a click.

**2. How do you keep that trust from being misused?**
- Trust is earned per product: milk does not unlock butter.
- An amount far from what the kitchen usually orders stops the agent. That is what a typo looks like.
- Reject one order the agent finished and its autonomy is switched off.
- Some rules no setting unlocks: allergens and diets, quantities nobody wrote, alcohol, late or partial deliveries.
- One switch stops every agent.

**3. How does an outside agent work with Valio's systems safely?**
The guardrails live in an open gateway, not in the agent. Any agent (Claude, GPT, your own) connects over MCP or REST with an OpenAPI document and meets the same rules. There is no tool or route that lets an agent approve.

**4. How do you find the right product among thousands without flooding the API?**
Local full-text search over the 17,546 products of the dataset in Finnish, English and Swedish, filtered by diet, allergen, label and origin. Valio's price and availability API is asked only for a shortlist of at most 50 products, never for all.

**5. What if the exact request cannot be met?**
Nine named exceptions, each with a plan. Partial stock is split across up to three products. For unknown stock, a sure-delivery option is shown next to the cheapest one. If the API is down, cached offers are used and a person must approve.

**6. How do you choose on more than price?**
Every option is scored on price, availability, delivery reliability, CO2 and Finnish origin.

**7. How does a person know what the agent did and why?**
Each line carries a reason built from computed facts. The proposal shows what the agent understood next to the person's own words. Every step is written to an append-only decision record.

**8. Who remembers to order?**
The agent reads the kitchen's stock system (mocked) and proposes refills before something runs out. It also turns a recipe and a number of portions into an order, each line traced to the recipe.

## How we use the Google Gemini API

Gemini (structured JSON output, temperature 0) does the three language jobs rules cannot:

- **Understands the request.** "Oat bread for Monday" in English, Finnish or Swedish becomes the Finnish product noun, quantity, date and diets.
- **Checks the product type.** Among search hits it tells oat bread from an oat bread mix. It can only remove candidates, never add one.
- **Reads recipes.** It turns ingredient lines into things to buy and skips water and salt.

Gemini never decides price, allergens, quantities or approval. Rules re-check what it returns, and if it is off or slow, everything runs on rules.

## Demo story

1. An unexpected party on Monday: 200 litres of lactose-free milk. The agent shows the cheapest option (€202, stock not confirmed) next to a sure-delivery one (€496). The owner checks and approves.
2. That was the third clean approval. The system suggests autonomy up to €500; the owner accepts.
3. The manager calls: twice as many guests, another 200 litres. The agent finishes the order on its own.
4. 1,000 litres, the brief's own example: the agent stops. Five times the usual amount, over the limit.

## Tech

TypeScript on Node, one codebase. Hono with zod-openapi (REST + OpenAPI 3.1), the Model Context Protocol SDK, SQLite with FTS5, React + Vite, Google Gemini API. 41 automated tests.

## Honest limits

- No real order is placed: there is no order API. The result is an approved order file by GTIN; its layout is not yet verified against the webshop import.
- The stock system is a mock, and the demo runs on a fixed clock.

## Next

A real order API plugs in where the order file is today; nothing else changes. Valio told us human approval may be relaxed if reliability proves good. The trust ladder makes that measurable.
