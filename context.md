# Trusted Trade Agents: product specification

An AI purchasing agent that buys food from Valio Aimo safely, openly and with the right human sign-off.

Version 2.1-draft, 2026-11-14 (stack: TypeScript). Replaces v1.1 (kept as `context-v1.1-old.md`).
Built on: the official challenge brief, the Valio Aimo dataset and mock API, organiser answers on Discord, and a read-only look at the live webshop (toimitustukku.valioaimo.fi).
This file is the source of truth for behaviour. Change it first, then the code.

---

## 1. What we are building

A buyer (a person, or the buyer's own AI agent) states a need: *"1,000 litres of lactose-free milk by Monday, best on price and availability."*
Our agent turns it into a **ready-to-approve order proposal** for the Valio Aimo webshop: matched products, fixed prices, quantities in real sales units, delivery date, and a written reason for every choice. A policy decides whether the agent may finalise it alone or a human must sign off. The approved order is exported as a file the webshop already imports.

The wholesaler-facing part is an **open gateway**: the same functions are exposed as MCP tools and a REST API with an OpenAPI document. Any outside agent (Claude, GPT, ours) can use it, and every one of them hits the same guardrails. Guardrails live in the gateway, not inside a particular agent.

### 1.1 Challenge flow → our product

| Brief step | What we do |
|---|---|
| 1 Request | Free text or a form becomes a structured `PurchaseRequest` (section 6). Ambiguity → one clarification question, never a guess |
| 2 Lookup | Local search over product data → short list (≤ 50 per item) → one price call and one availability call for that list only |
| 3 Order | Quantities, sales units and a split across products or dates when needed. Prices are frozen from the price API with their validity |
| 4 Approval | Policy check. Default: a human signs off every order. The customer can grant the agent more autonomy step by step (trust ladder, section 8.4) |

### 1.2 Judging criteria → where we score

| Criterion | Weight | Our answer |
|---|---|---|
| Working end-to-end demo | 30 % | One product, no separate demo engine. Real API, with a recorded response cache as backup (section 11.3) |
| Solving the user's need | 20 % | The brief's own example, end to end, with real data and a file that imports into the real webshop cart |
| Autonomy and controls | 20 % | Policy at the gateway, per-agent credentials, hard rules that cannot be switched off, trust ladder |
| Robustness to exceptions | 15 % | Nine named exceptions, each with a defined handling (section 7) |
| Openness and path to production | 15 % | MCP + OpenAPI, documented decision records, export into today's webshop, clear seam where an order API plugs in |

### 1.3 Non-goals

- **Not a chatbot.** One request in, one proposal out. Questions only when the request is ambiguous.
- No real order placement. There is no order API; organisers confirmed an approval-ready order is enough.
- No payments, no invoices. Prices are shown excluding VAT, with VAT as reported by the API.
- No voice input. No marketplace with other wholesalers. No menu planning, no price negotiation.
- No post-order event handling (recalls, delays after confirmation). Stretch only.

---

## 2. Facts we rely on

### 2.1 From organisers (Tommi, Valio Aimo, 2026-11-14)

- No order API. Producing orders for human approval is enough.
- `closingTime` is the order cut-off for the returned `availableDate`. Mock data stays the same all weekend.
- `availableAmount >= 999999` means the amount is unknown and any quantity may be ordered. Seen values: 999999, 666666666, 9999999999, also on `Stock` products. Empty `scheduleLines` means not available.
- `allowedLotSize` 0.01 must be treated as 1.
- Rate limit: HTTP 429 blocks the caller for 30 s. A few hundred calls per minute is fine; a burst within 10 s is not.
- Valio enforces no approval today. Customers rely on internal rules or let only managers order. In an agentic flow a human approval is required now; it may be relaxed later if reliability proves good.

### 2.2 From the dataset (`valio/data/`)

| File | Content | Coverage |
|---|---|---|
| `product_data.json` | 17,546 products, 648 vendors, 349 category codes (no names), names in fi/en/sv | 100 % names |
| `carbon_footprint.csv` | kg CO2e per kg | 63 % of products |
| `delivery_reliability.csv` | share delivered on time, per product | 25 % of products |
| `openapi.json` | mock API contract | — |

Data quality that shapes the rules:
- Allergens use GS1 codes with `CONTAINS`, `MAY_CONTAIN`, `FREE_FROM` (groups `allergen`, `nonAllergen`). **46 % of products have no allergen statement at all** (neither `allergen` nor `nonAllergen` entries); 59 % list no `CONTAINS`/`MAY_CONTAIN`, including obvious ones (a salmon fillet with no fish entry).
- Diet claims live in `nutritionalClaim`: `FREE_FROM_LACTOSE` (4,178), `FREE_FROM_GLUTEN` (3,047), `VEGAN`, `VEGETARIAN`.
- Labels live in `packagingMarkedLabel`: Finnish origin marks, EU organic, MSC, ASC, Fairtrade and more.
- Only 250 substitution pairs exist (product → product). There is no product-type taxonomy.
- Sales units are technical codes (`ST`, `KI`, `PAK`, `KG`, `BOT`…). Pack content comes from `units[].sizeInBaseUnits` and `synkkaData.unitConversions`. Checked against the price API on 1,000 random products: content is derivable for 60 % of products and matches `catalogPrice / comparisonPrice` within 3 % in 96 % of those; the rest look like drained vs net weight.
- Dataset ids (e.g. `464237`) differ from webshop codes for the same product (`8042224`). Join to the webshop by GTIN, never by id.

### 2.3 From the mock API (`https://junction26.valioaimo.fi`, header `X-API-Key`)

- `POST /api/availability` and `POST /api/price`, body `{customer, requestedDate, products[1..1000]}`. `customer` is ignored.
- Price: `catalogPrice` per sales unit ex-VAT, `comparisonPrice` per `KG` or `L`, `listPrice`, `validFrom`/`validTo`, `tax`. A price is returned even for products that cannot be delivered.
- Availability: `logisticModel` `Stock` or `Terminal`, `salesBlock`, `closingTime`, and at most one `scheduleLine` with `availableAmount`, `availableDate`, `salesUnit`. `availableDate` may differ from the requested date.
- Quirk seen on 2026-11-14: `Terminal` products return a `closingTime` already in the past (12 Nov) for an `availableDate` of 16 Nov. Open question 15.1.

### 2.4 From the webshop (read-only look, shared test account)

- One open cart per delivery date; the delivery date drives the cut-off.
- The cart flags lines not deliverable on the chosen date and offers the next possible date.
- Unavailable products show a "see substitutes" link.
- Carts import from a file or an order template, and export to Excel. **This is our export target.**
- Order templates are private, shared (same customer) or central (editable only by the main user, *pääkäyttäjä*). So two user levels already exist.
- Search filter "Ei sisällä" (free from) uses the same allergen data we have.
- The test account is shared by all teams and its carts change constantly. Never rely on it during the demo; never place an order.

---

## 3. Users, roles and actors

| Role | Who | Mirrors in today's webshop | Can |
|---|---|---|---|
| Owner | The one person running the customer's purchasing (one master user in the demo) | Main user (*pääkäyttäjä*) | Everything: create requests, edit proposals, approve or reject, edit the policy, grant agent credentials |
| Agent | Any AI agent holding a gateway key | — (new) | Search, check offers, build proposals. **Never approve, never export as approved** |
| Admin | Our team / Valio service desk | — | Kill switch per customer, read all decision records |

An agent key belongs to one customer and carries its own limits (section 8). Every caller sends `Authorization: Bearer <token>`; a token maps to customer, role and limits (demo tokens `demo-owner` and `demo-agent` are seeded for the demo customer). People have one role on purpose: the line that matters is person vs agent, and an agent can never approve. A customer-level switch turns all its agent keys off (kill switch). The first demo customer is a fictional hotel chain, "Hotel Kaisla", with two sites.

---

## 4. Architecture

```
Buyer / buyer's agent ──► Gateway (MCP + REST, one codebase, TypeScript)
                              │
       ┌──────────────────────┼─────────────────────────┐
       ▼                      ▼                         ▼
 Catalogue (SQLite + FTS5   Offer client (mock API,   Policy engine
 from dataset files)        shortlist only, cache,    (hard rules + customer
                            429 back-off)             policy, per-agent limits)
       └──────────────► Planner ◄────────┘                │
                         (filter, score, split)            ▼
                              │                  Approval UI (web) ──► Export (.xlsx/.csv
                              ▼                                          for webshop import)
                     Decision record (append-only audit, human-readable)
```

- **One implementation.** TypeScript on Node (≥ 22) end to end. REST with Hono; the OpenAPI document is generated from the same zod schemas the routes validate with (`@hono/zod-openapi`). MCP tools (`@modelcontextprotocol/sdk`) are thin wrappers over the same functions. Storage is the built-in `node:sqlite` with FTS5; tests use `node:test`. A small web UI (React + Vite) for the human side shares the zod types. No second engine in the browser.
- **LLM** (Gemini through its OpenAI-compatible endpoint; any OpenAI-compatible endpoint by environment: `GEMINI_API_KEY`, `LLM_MODEL`, `LLM_BASE`). Jobs:
  1. **Parse** text into a `PurchaseRequest`, normalising the need to the Finnish product noun used in product names ("oat bread" → `kauraleipä`). The rules parser runs too: its diet/allergen findings are always added, and its quantities, units and date win when it found them, so a model misreading "1,000" cannot change the order.
  2. **Product-type check**: after the local search, the model sees the need and the candidate names and says which ones *are* that product. It can only **remove** candidates (each removal is listed with its reason), never add one. Substring search alone cannot tell `kauraleipä` from `kauraleipämix`.
  3. Wording the explanation from computed facts: not built; the template reason stays.
  The model never sees or decides prices, allergen/diet eligibility, quantities or policy verdicts. Model off, slow or failing → rules only, the product keeps working.
- **Seam for production**: the order sink is one function today (`toCsv`, file export by GTIN). A real order API becomes a second sink next to it; nothing else changes. (No interface until the second implementation exists.)
- **Text parsing today**: rules only (`src/parse.ts`: quantities, units, dates, weekdays, diets, allergens in en/fi/sv; asks when quantity or product is missing). The LLM path plugs in when the provider is decided (15.4); the keyword detector stays in front of it either way.


### 4b. Recipes → order

Valio Aimo publishes 2,091 professional-kitchen recipes (JSON search API `valioaimo.fi/valio-search-client/recipes/?account=valioaimo`, `haku=` text search, facets for course, diet, kitchen type; each recipe page has schema.org `Recipe` JSON-LD with `recipeYield` in portions and every `recipeIngredient` in kg). Quantities in kg match the planner directly.

- **Data**: `npm run recipes` (online, ~2 min, one request at a time) picks 15 simple recipes (≤ 10 lines, every line `<n> kg <name>`, ≥ 80 % of buyable lines found in the catalogue, no alcohol) across soup, main, salad, side, dessert, vegan, into `data/recipes.json`. Valio content: gitignored, never published. The model normalises each line once (`0,900 kg täysjyväpastaa` → need `täysjyväpasta`; water → skip; salt, pepper, frying oil → `pantry`); rules without a key. Valio products the recipe names (EANs in the listing) are linked to their line.
- **Scaling** (`scaleRecipe`): × portions / yield, rounded up to 10 g, same ingredient on two lines merged. Skipped lines are listed with the reason: nothing to buy (water), to taste (0 kg), usually in stock (pantry, unless ticked).
- **Planning**: `POST /recipes/{id}/plan` → the same `createProposal` as every other path (limits, three items at a time, policy, decision record). An item may name a product (`items[].product`): it is always a candidate when it meets the limits, the AI check cannot remove it, and it is allocated first when deliverable; otherwise the line says why not ("order cut-off passed (E6)"). Liquids the recipe weighs are matched to litre products at 1 l = 1 kg (flag `litre_as_kg`).
- **Trust**: no source text, so `matches_request_text` does not apply; instead the proposal shows every quantity traced to its recipe line (`0,900 kg täysjyväpastaa × 120/18 portions = 6 kg`) and every skipped line. `usual_quantity` applies as usual.
- **Coverage today** (100 portions, Wed 18 Nov, recorded): 7 of 15 recipes fully covered; the gaps are cut-offs (E6), not deliverable (E2), and a few products not in the dataset (E1: Valio curd fillings, tyrnimehu, fresh strawberries).
- Not built: menus of several recipes with shared ingredients summed; MCP tools for recipes.
---

## 5. Gateway interface (MCP tools = REST routes)

| Tool / route | Who | Does |
|---|---|---|
| `search_products` · `GET /products/search` | agent, user | Text (fi/en/sv) + filters: free-from allergens, diets, labels, origin, category. Local data only, no API call |
| `get_product` · `GET /products/{id}` | agent, user | Static product data incl. allergens, claims, labels, CO2, reliability |
| `check_offers` · `POST /offers` | agent, user | Price + availability for ≤ 50 ids and a date. Cached. The only route that calls the mock API |
| `create_proposal` · `POST /proposals` | agent, user | Takes a `PurchaseRequest`, runs the planner, returns a proposal with decision record and policy verdict |
| `get_proposal` · `GET /proposals/{id}` | agent, user | Proposal, lines, alternatives, exceptions, verdict |
| `revise_proposal` · `PATCH /proposals/{id}` | agent, user | Change a line (choose another option, change quantity). Re-runs checks |
| `decide` · `POST /proposals/{id}/decision` | **human only** | Approve or reject. Not exposed as an MCP tool. Agent keys get 403 |
| `export_proposal` · `GET /proposals/{id}/export` | human (approved), agent (only `auto_approved`) | Webshop import CSV: `gtin;product_id;name;quantity;sales_unit;unit_price_eur;line_total_eur;delivery_date`, `;` separated, decimal comma, UTF-8 BOM. Layout is a placeholder until 15.2 is answered. Marks the proposal `exported`, file hash in the audit |
| `POST /parse` | agent, user | Free text → `PurchaseRequest` or a clarification question |
| `GET /proposals` | agent, user | Latest proposals of the caller's customer |
| `GET /policy`, `PUT /policy` | owner (agents read only) | Customer policy (section 8) |
| `GET /audit` | all | Decision records |

Every response that the agent acts on carries `policy_verdict` and `requires_human: true/false`, so an outside agent can tell its user exactly what happens next.

---

## 6. Request model

```json
{
  "site": "Hotel Kaisla Helsinki",
  "deliver_by": "2026-11-16",
  "items": [
    {"need": "lactose-free milk", "quantity": 1000, "unit": "l"}
  ],
  "exclude_allergens": [],
  "diets": ["lactose_free"],
  "labels_required": [],
  "priorities": "price_and_availability",
  "budget_eur": null,
  "source_text": "I need 1,000 litres of lactose-free milk by Monday..."
}
```

- `unit` is `kg`, `l` or `pcs` (`pcs` = sales units as sold, no content conversion). `priorities` picks a weight preset (section 9.3).
- Diet and allergen words found by the keyword detector in `source_text` are always added, even if the model left them out. The model can add a limit, never remove one.
- Missing date → next delivery date whose cut-off has not passed, stated in the proposal. A date in the past → clarification.

---

## 7. Planner rules and exceptions

### 7.1 Steps per item

1. **Find**: full-text search over fi/en/sv names; the category most hits fall into ranks first. Only name matches are candidates: widening by category was removed after it turned "kauraleipä" into wheat toast when every oat bread was undeliverable. Max 200 local candidates.
2. **Hard filters** (local data, each exclusion recorded with its reason): sales block in data, excluded allergen (`CONTAINS` **or** `MAY_CONTAIN`), required diet not satisfied, required label missing, **no allergen statement while any allergen or diet limit applies** ("allergen data missing"). Unit matching is **not** a local filter: content is often missing in data but known to the price API, so it is checked after offers (7.2).
3. **Shortlist**: top 50 eligible, the dominant category first. 50, not 30: the milk category alone has 36 eligible lactose-free products, and cutting a category can hide the cheapest option. Still one call per item.
4. **Offers**: one `check_offers` call for the shortlist and `deliver_by`.
5. **Score** the deliverable ones (section 9), rank, explain.
6. **Allocate** the quantity (section 7.2).

Diet satisfaction:

| Diet | Satisfied when |
|---|---|
| `lactose_free` | claim `FREE_FROM_LACTOSE`, or `nonAllergen` `ML` = `FREE_FROM`, or product states no `AM` (milk) and has an allergen statement |
| `gluten_free` | claim `FREE_FROM_GLUTEN`, or `AW` = `FREE_FROM`, or no `AW`/`UW`/`GB`/`NR`/`GO`/`ST` and has a statement |
| `vegan`, `vegetarian` | the matching `DIET` claim only |

### 7.2 Quantity and allocation

- Content per sales unit (litres or kg) comes from `units[]` × base-unit content in `unitConversions`. If missing, use `catalogPrice / comparisonPrice` when `comparisonUnit` is the needed unit, and flag the line `content_from_price`. If the data value differs from the API value by more than 3 %, use the API value and flag `content_mismatch` (the price per kg/l is computed by Valio on that basis). Still unknown → option dropped with reason "unit cannot be matched".
- Sales units needed = `ceil(quantity / content)`, rounded up to a multiple of `allowedLotSize` (values below 1 count as 1; 1.5, 2, 3… occur in data). The schedule line's `salesUnit` equals the product's sales unit (checked on the milk shortlist).
- Allocation: fill from the best-ranked on-time option; late options (E3) only after all on-time ones. If its known amount is short, take the rest from the next option (**split**), up to 3 products per item. Each part keeps its own reason.
- Lines whose `availableDate` is later than `deliver_by` go into a separate delivery date (= separate webshop cart). Never silently.

### 7.3 Exceptions

| # | Exception | Detection | Handling |
|---|---|---|---|
| E1 | No match | No candidate after filters | Unmatched line with reasons; filtered-out list shown |
| E2 | Not deliverable | Empty `scheduleLines` or `salesBlock` | Option dropped; substitutes from the substitution pairs, then same category |
| E3 | Late | `availableDate` > `deliver_by` | Offer "later date" and "substitute on time"; needs human |
| E4 | Partial | Known `availableAmount` < needed | Split across products (7.2); if still short, shortfall stated |
| E5 | Unknown amount | `availableAmount >= 999999` | Not sure to be delivered. Allocation uses confirmed stock first; an E5 line only fills what confirmed stock cannot, and any E5 line needs a person (hard rule `confirmed_stock`) |
| E6 | Cut-off passed | `closingTime` < now | Treated as not deliverable for that date; offer the next date |
| E7 | No price | Price `error: true` or missing | Option dropped with reason |
| E8 | Allergen data missing | No statement while a limit applies | Never in the ranking; listed so a human can check and add manually |
| E9 | API trouble | 429, timeout, 5xx | Wait 30 s on 429 and retry once; serve cached responses; say "prices from cache, fetched at …" |

Before approval the gateway re-runs `check_offers` for the chosen lines. If price or availability changed, the proposal goes back to `needs_review` with the difference shown.

---

## 8. Human control

### 8.1 Hard rules (no setting changes them)

1. No line breaks the request's allergen or diet limits. Missing data counts as non-compliant.
2. Agents cannot approve, and cannot export a proposal that needed a human.
3. Substitutes that add an allergen are never recommended and never auto-approved.
4. Alcohol categories always need a human (licence and quota rules exist in the webshop).
5. Every line carries a reason built from computed facts; every number in the explanation must appear in those facts, otherwise the template text is used.
6. Ambiguous request → clarification. Policy engine error → `requires_human`.
7. Only orders sure to be delivered: a line without stock confirmed by Valio (E5) always needs a person (`confirmed_stock`). The agent never accepts that risk on its own.
8. Plausible but wrong requests (the person typed or the agent read 1000 for 100) pass every other rule, so:
   - `matches_request_text`: with a source text, every item quantity must be a number written in it (500 g → 0.5 kg counts). An agent that misreads, or revises a quantity later, needs a human.
   - `usual_quantity`: with at least 3 approved past orders in the same category and unit, a quantity ≥ 3× or ≤ ⅓ of their median needs a human ("usually 200 l"). Demo: the 1,000 l request after five ~200 l orders.
   - Read-back: every proposal shows the original text next to the request as understood. Each field is marked from the text, assumed (date, priorities) or not in the text (quantity, added limit). Computed by rules (`readBack`), so it also checks an outside agent's interpretation.

### 8.2 Customer policy (the owner edits)

| Field | Default | Meaning |
|---|---|---|
| `agent_may_finalise` | **false** | Master switch. Off = every proposal needs a human (today's expectation) |
| `max_order_eur` | 500 | Above this, a human signs off even if the switch is on |
| `max_line_eur` | 200 | Same, per line |
| `allow_substitutes` | false | Auto-finalise proposals that contain a substitute. *Not implemented yet: lines are matched to a need, not substituted for a named product; comes with named-product requests* |
| `allow_split` | true | Auto-finalise split lines |
| `max_over_best_price_pct` | 10 | Chosen option may cost at most this much more per kg/l than the cheapest option sure to arrive (confirmed stock, on time) |
| `weights` | preset | Scoring weights (9.3). *For now the request's `priorities` picks the preset* |

Per-agent key limits are a subset: an agent key can be stricter than the customer policy, never looser.

When `agent_may_finalise` is on, one more check applies: `routine_order`. The agent finishes an order alone only if every item's category and unit has at least 3 approved orders before. Trust earned on milk does not let the agent order fish.

Unconfirmed stock is not a setting: an order is sure to be delivered or a person accepts the risk (`confirmed_stock`, 8.1).

### 8.3 Proposal lifecycle

`draft` → (`needs_review` | `auto_approved`) → `approved` → `exported`; also `rejected`, `expired` (cut-off or price validity passed).
`auto_approved` exists only when every policy rule passed; it is still undoable until export.

### 8.4 Trust ladder

The gateway counts approvals in a row that a human made without changing the proposal. After **3**, it suggests letting the agent finish routine orders up to the largest approved total (rounded up to €50): *"You approved 5 proposals in a row without changing them. Let the agent finish routine orders up to €550 on its own?"*

- **Learned from what was accepted**: a soft yes/no rule (today `allow_split`) that failed in *every* approval of the streak is switched on in the suggestion ("including orders split across products, as you accepted each time"). Hard rules are never learned.
- **Lost at once**: a change or a rejection resets the count; rejecting an order the agent finished alone (`auto_approved`) switches `agent_may_finalise` off immediately (audit event `autonomy_revoked`).
- **Visible**: every order the agent finishes alone pops up in the UI ("The agent finished an order on its own") until someone acknowledges it.

The suggestion never changes the policy itself. This is Valio's own path ("may be dropped if reliability is good enough") made measurable.

### 8.5 Decision record

For each proposal: the request, filters with excluded products and reasons, shortlist, the raw price and availability responses (with fetch time), scores per criterion, allocation, exceptions, policy results per rule, the human decision with time and user, and the export file hash. Append-only. Shown as a readable timeline and exportable as JSON.

---

## 9. Scoring

Only eligible, deliverable options are scored. All criteria are 0..1, higher is better.

| Criterion | Score | Default weight |
|---|---|---|
| Price | lowest price per l/kg ÷ this one (price per sales unit ÷ content from 7.2, so it matches what is paid) | 0.40 |
| Availability | 1 = on time and known amount covers the need; 0.7 = on time, amount unknown; 0.4 = on time, partial; 0 = late (E3) | 0.25 |
| Reliability | value from the file; missing → vendor mean; else 0.9 | 0.15 |
| CO2 | lowest kg CO2e/kg ÷ this one; missing → criterion skipped, weights rescaled | 0.10 |
| Origin and labels | 1 if `fi` or a Finnish origin mark; +0.5 per required/preferred label, capped at 1 | 0.10 |

Ties: lower total cost, then product id. Weight presets (price / availability / reliability / CO2 / origin): `price_and_availability` 0.40/0.25/0.15/0.10/0.10, `sustainability` 0.30/0.20/0.10/0.30/0.10, `reliability_first` 0.30/0.20/0.35/0.05/0.10.

---

## 10. Data model (SQLite)

- `products` (from the JSON, flattened): id, gtin, names fi/en/sv, vendor, category, origin, sales unit, lot size, content per sales unit + unit, allergens contains/may/free (JSON), claims, labels, temperature class, co2, reliability. `products_fts` over names.
- `substitutions` (product, substitute).
- `offer_cache`: endpoint, product, date, response JSON, fetched_at.
- `customers`, `sites`, `users` (role), `agent_keys` (customer, limits, revoked).
- `customers.policy` (section 8.2, JSON), `tokens`, `proposals` (request, planned items with options, offers, allocation and verdict as JSON), `audit` (append-only, enforced by triggers; decisions are audit events).

Money in integer cents ex-VAT; VAT rate stored per line from the API.

---

## 11. Demo

### 11.1 Fixed facts (checked against the API on 2026-11-14, date 2026-11-16)

36 lactose-free products in the milk category (10400) pass the filters. Examples:

| Product (dataset id) | Model | Amount | €/l |
|---|---|---|---|
| Valio Arki Eila kevytmaitojuoma 1 l (464306) | Stock | unknown (≥ 999999) | 1.01 |
| Valio Eila rasvaton maitojuoma 1 l (464401) | Stock | unknown | 1.10 |
| Arla Kevytmaitojuoma 1 L (469363) | Stock | 384 | 2.48 |
| Arla Maitojuoma 1 L rasvaton (462775) | Stock | 51 | 2.57 |
| Valio kevytmaito 0,5 l (464440) | — | not available | — |

Stock products have cut-off 15 Nov 17:00; Terminal products report 12 Nov (E6).

### 11.2 Scenes (3 minutes)

1. **Request (outside agent)**: in Claude Desktop, connected to our gateway over MCP, say the brief's sentence. The agent calls `search_products`, `check_offers`, `create_proposal`. Point: an outside agent works through an open standard. Even if the agent forgets the diet, the keyword detector adds "lactose-free" from its `source_text` (checked in the dry run).
2. **Proposal**: open the approval UI. Only stock Valio confirms: 384 + 51 + 565 l across three Arla products, €2,580.64, every line sure to arrive. The cheaper Eila (€1.01/l) is in the comparison, marked "stock not confirmed"; the 0.5 l product is not available (E2); Terminal products dropped for a passed cut-off (E6). Each line says why.
3. **Guardrail**: the agent tries to finalise; the gateway answers `requires_human` (over €500, and 5× the usual 200 l). The agent tells its user so.
4. **Human**: the owner may pick Eila to save €1,570, but then "Sure to be delivered" becomes a hard check they accept themselves; they go back to the agent's pick. Approve (prices re-checked first): the "Order approved" dialog, then "Download webshop file".
5. **Trust**: after `npm run demo:reset` (five ~200 l orders approved unchanged) the banner suggests "routine orders up to €550". Accept it; the agent orders 200 l: finished on its own, the pop-up says so. It orders 1,000 l: stopped by "Usual amount".
6. *(optional)* **Recipe**: Recipes → a soup → 120 portions → Plan order. Every line traced to the recipe, Valio products named in the recipe used first, a passed cut-off shown on its line.
7. **Path to production**: show the file and the decision record; one line on importing it into today's webshop cart ("Tuo tiedostosta") and where the order API would plug in. Trust ladder banner as the closing line.

### 11.3 Demo safety

- Record all API responses used by the scenes into `offer_cache` the day before (`npm run record`); the demo reads the cache if the API is slow or down, and says so on screen ("API trouble, cached offers used", which also makes the proposal need a human). `VALIO_TIMEOUT_MS` shortens the wait on a slow network.
- `npm run demo:reset` empties proposals and the decision record and adds five small milk orders approved unchanged, so the trust-ladder banner is on screen for the closing line. Demo fixture only.
- `npm run demo` serves the UI and the API from one process.
- Fixed demo clock (`DEMO_NOW`), so cut-offs behave the same at judging time.
- Never touch the shared webshop account during the demo.

---

## 12. Non-functional

- Secrets (`VALIO_API_KEY`, LLM key) only from environment; `.env.example` in the repo.
- API politeness: shortlist only, ≤ 50 ids per call, client throttle 5 calls/s, 429 → 30 s wait.
- Every query filtered by the caller's customer. Agent keys revocable; admin kill switch.
- Product search < 100 ms; proposal for one item < 3 s with a warm cache.
- The dataset licence allows use for Junction 2026 only. Do not publish it.

---

## 13. Tests (definition of done)

1. Diet/allergen property test over the whole catalogue: no proposal line ever violates the limits.
2. Golden test: the milk request on cached responses gives the expected shortlist, exceptions E2, E6, a stable ranking, and an allocation from confirmed stock only (384 + 51 + 565 l).
3. Quantity: lot size 0.01 → 1; content from price and content mismatch flagged; split never exceeds known amounts.
4. Policy: each rule at and over its limit; agent key cannot call `decide` (403) and gets no MCP tool for it; alcohol always human.
5. Re-validation: changed cached price → `needs_review` with the difference.
6. 429 handling with a fake server.
7. Export file matches the webshop import format (open question 15.2).

Manual: all scenes twice, once with the model off.

---

## 14. Team split and timeline (48 h)

| Role | Owns |
|---|---|
| A · Planner | Data loader, filters, diet rules, scoring, allocation, exceptions, golden test |
| B · Gateway | Hono routes, MCP server, offer client + cache + 429, policy engine, audit, export |
| C · UI | Approval UI: proposal view, alternatives, decision, policy editor, decision timeline, trust banner |
| D · Agent + pitch | LLM parse/explain + fallback, Claude Desktop MCP setup, demo script, rehearsal |

| Hours | Milestone |
|---|---|
| 0–6 | Data loader + offer client with cache; request schema frozen; MCP "hello" from Claude Desktop |
| 6–20 | Milk request end to end through REST, no UI |
| 20–32 | Approval UI, policy, export; MCP tools complete |
| 32–42 | Exceptions polish, trust ladder, record the cache, two dry runs |
| 42–48 | Pitch rehearsal |

Cut order if late: trust ladder banner → sustainability preset → LLM explanation (template stays) → second site.

---

## 15. Open questions

1. Terminal products return a `closingTime` in the past for a future `availableDate`. Can they be ordered for that date or not? (Ask organisers. Until then: E6.) **High impact:** whole product groups disappear, e.g. 12 of 14 oat breads (all Terminal, cut-off 12 Nov 12:30, available 16 Nov).
2. Exact webshop import file format. Get it by exporting a cart with "Vie Exceliin" and importing a test file into an empty cart at the booth.
3. Is the GS1 allergen code mapping (AM milk, AW gluten, ML lactose, …) confirmed by Valio for this dataset?
4. Hosted LLM allowed for the demo, or local only? (We use Gemini; request text and product names are sent to Google. Confirm with organisers.)
6. May we use Valio Aimo's public recipes (§4b) in the demo? We keep 15 locally, fetched once, not published.
5. Team size, pitch slot and whether judging happens before Sunday 17:00 (the stock cut-off in the mock data).
