# Trusted Trade Agents: product specification

An AI purchasing agent that buys food from Valio Aimo safely, openly and with the right human sign-off.

Version 2.1-draft, 2026-11-14 (stack: TypeScript). Replaces v1.1 (in git history).
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
| Solving the user's need | 20 % | The brief's own example, end to end, with real data and an order file keyed by GTIN for the webshop's cart import (column layout not yet confirmed, 15.2) |
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
| Admin | Our team / Valio service desk | — | Read all decision records (the kill switch itself is the owner's: Policy page, `PUT /agents`) |

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
                              │                  Approval UI (web) ──► Export (.csv
                              ▼                                          for webshop import)
                     Decision record (append-only audit, human-readable)
```

- **One implementation.** TypeScript on Node (≥ 23.6) end to end. REST with Hono; the OpenAPI document is generated from the same zod schemas the routes validate with (`@hono/zod-openapi`). MCP tools (`@modelcontextprotocol/sdk`) are thin wrappers over the same functions. Storage is the built-in `node:sqlite` with FTS5; tests use `node:test`. A small web UI (React + Vite) for the human side shares the zod types. No second engine in the browser.
- **LLM** (Gemini through its OpenAI-compatible endpoint; any OpenAI-compatible endpoint by environment: `GEMINI_API_KEY`, `LLM_MODEL`, `LLM_BASE`). Jobs:
  1. **Parse** text into a `PurchaseRequest`, normalising the need to the Finnish product noun used in product names ("oat bread" → `kauraleipä`). The rules parser runs too: its diet/allergen findings are always added, and its quantities, units and date win when it found them, so a model misreading "1,000" cannot change the order.
  2. **Product-type check**: after the local search, the model sees the need and the candidate names and says which ones *are* that product. It can only **remove** candidates (each removal is listed with its reason), never add one. Substring search alone cannot tell `kauraleipä` from `kauraleipämix`.
  3. Wording the explanation from computed facts: not built; the template reason stays.
  The model never sees or decides prices, allergen/diet eligibility, quantities or policy verdicts. Model off, slow or failing → rules only, the product keeps working.
- **Seam for production**: the order sink is one function today (`toCsv`, file export by GTIN). A real order API becomes a second sink next to it; nothing else changes. (No interface until the second implementation exists.)
- **Text parsing**: rules (`src/parse.ts`: quantities, units, dates, weekdays, diets, allergens in en/fi/sv; asks when quantity or product is missing) plus the model when a key is set; what the rules found always wins.


### 4b. Recipes → order

Valio Aimo publishes 2,091 professional-kitchen recipes (JSON search API `valioaimo.fi/valio-search-client/recipes/?account=valioaimo`, `haku=` text search, facets for course, diet, kitchen type; each recipe page has schema.org `Recipe` JSON-LD with `recipeYield` in portions and every `recipeIngredient` in kg). Quantities in kg match the planner directly.

- **Data**: `npm run recipes` (online, ~2 min, one request at a time) picks 15 simple recipes (≤ 10 lines, every line `<n> kg <name>`, ≥ 80 % of buyable lines found in the catalogue, no alcohol) across soup, main, salad, side, dessert, vegan, into `data/recipes.json`. Valio content: gitignored, never published. The model normalises each line once (`0,900 kg täysjyväpastaa` → need `täysjyväpasta`; water → skip; salt, pepper, frying oil → `pantry`); rules without a key. Valio products the recipe names (EANs in the listing) are linked to their line.
- **Scaling** (`scaleRecipe`): × portions / yield, rounded up to 10 g, same ingredient on two lines merged. Skipped lines are listed with the reason: nothing to buy (water), to taste (0 kg), usually in stock (pantry, unless ticked).
- **Planning**: `POST /recipes/{id}/plan` → the same `createProposal` as every other path (limits, three items at a time, policy, decision record). An item may name a product (`items[].product`): it is always a candidate when it meets the limits, the AI check cannot remove it, and it is allocated first when deliverable; otherwise the line says why not ("order cut-off passed (E6)"). Liquids the recipe weighs are matched to litre products at 1 l = 1 kg (flag `litre_as_kg`).
- **Trust**: no source text, so `matches_request_text` does not apply; instead the proposal shows every quantity traced to its recipe line (`0,900 kg täysjyväpastaa × 120/18 portions = 6 kg`) and every skipped line. `usual_quantity` applies as usual.
- **Coverage today** (100 portions, Wed 18 Nov, recorded): 7 of 15 recipes fully covered; the gaps are cut-offs (E6), not deliverable (E2), and a few products not in the dataset (E1: Valio curd fillings, tyrnimehu, fresh strawberries).
- Not built: menus of several recipes with shared ingredients summed; MCP tools for recipes.

### 4c. Stock system → refill (mock)

Kitchens keep stock in their own software. The agent reads it and proposes a refill before something runs out, so the order starts from data, not from a person remembering.

- **Source**: `src/stock.ts` stands in for the kitchen's stock system: per product a name, the need (Finnish search term), unit, diets, amount on hand, daily use and par level (the level the kitchen refills to). Fixed readings for Hotel Kaisla; nothing moves when orders arrive. A real connector returns the same shape (§15.8).
- **Rule**: lasts = on hand ÷ daily use. Under 3 days → running low; refill = par − on hand − already on the way (open proposals made from stock, so a second check does not repeat them; a rejected refill makes it low again); deliver by the last full day it still lasts (at least tomorrow).
- **Routes**: `GET /stock` (levels, what is low, open refills); `POST /stock/check` (MCP `check_stock`): one proposal per low product, made by the customer's agent key even when the owner presses the button, so its limits apply and the kill switch stops it (403). One per product so a routine refill can finish alone while a new product waits.
- **Trust**: quantities are computed by the gateway, not read from words, so `matches_request_text` does not apply (like recipes); `usual_quantity` still catches a bad reading. The proposal carries `request.stock` (the reading it came from); the app shows "Why the agent ordered" (3 kg left, 1.5 kg a day, lasts 2 days, refill to 13 kg) and asks "Do you need this?" instead of "Is this what you meant?". A correction keeps the reading.
- **Demo data**: milk (80 l, 40 l/day, par 280 → 200 l by Mon 16 Nov) and butter (3 kg, 1.5 kg/day, par 13 → 10 kg) run low; cheese, cream, rice, eggs do not.
- Not built: real connectors, consumption forecasts, menu plans (recipes × days) as a source of future use, a schedule (the check runs on request).
---

## 5. Gateway interface (MCP tools = REST routes)

| Tool / route | Who | Does |
|---|---|---|
| `search_products` · `GET /products/search` | agent, user | Text (fi/en/sv) + filters: free-from allergens, diets, labels, origin. Local data only, no API call |
| `get_product` · `GET /products/{id}` | agent, user | Static product data incl. allergens, claims, labels, CO2, reliability |
| `check_offers` · `POST /offers` | agent, user | Price + availability for ≤ 50 ids and a date. Cached. The only route that calls the mock API |
| `create_proposal` · `POST /proposals` | agent, user | Takes a `PurchaseRequest`, runs the planner, returns a proposal with decision record and policy verdict |
| `get_proposal` · `GET /proposals/{id}` | agent, user | Proposal, lines, alternatives, exceptions, verdict |
| `revise_proposal` · `PATCH /proposals/{id}` | agent, user | Change a line (choose another option, change quantity). Re-runs checks |
| `decide` · `POST /proposals/{id}/decision` | **human only** | Approve or reject. Not exposed as an MCP tool. Agent keys get 403 |
| `export_proposal` · `GET /proposals/{id}/export` | human (approved), agent (only `auto_approved`) | Webshop import CSV: `gtin;product_id;name;quantity;sales_unit;unit_price_eur;line_total_eur;delivery_date`, `;` separated, decimal comma, UTF-8 BOM. Layout is a placeholder until 15.2 is answered. Marks the proposal `exported`, file hash in the audit |
| `POST /parse` | agent, user | Free text → `PurchaseRequest` or a clarification question |
| `GET /proposals` | agent, user | Latest proposals of the caller's customer |
| `check_stock` · `POST /stock/check`, `GET /stock` | agent, user | Read the kitchen's stock system (mock, §4c); a refill proposal per product running low, made under the agent key |
| `GET /policy`, `PUT /policy` | owner (agents read only) | Customer policy (section 8) |
| `GET /agents`, `PUT /agents` | owner (agents read only) | Kill switch: all agent keys of the customer on or off, effective at once, audited |
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
- Missing date → tomorrow; if the offers say that is too early, the first date every item can still be ordered for (one more round of offers). Stated in the proposal as assumed. A date in the past → clarification.

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
| E5 | Unknown amount | `availableAmount >= 999999` | Allowed in the best option, shown as "Delivery not confirmed". The planner also computes a **sure-delivery option** from confirmed stock only (`sure_option`: lines, cost, extra cost); one click (`confirmed_only`) switches to it. An E5 line needs a person unless the policy accepts it (`allow_unconfirmed_stock`, off by default) |
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
7. *(Now a policy setting, 8.2.)* Organisers: an amount ≥ 999999 means "unknown, any quantity may be ordered", so a line without a confirmed amount (E5) is not a fixed risk. By default it still needs a person (`confirmed_stock`); the owner can accept it with `allow_unconfirmed_stock`. While it is off, an agent finishing alone switches to the sure-delivery option and keeps it only if every check passes; otherwise the person sees the best option with the sure one next to it.
8. Plausible but wrong requests (the person typed or the agent read 1000 for 100) pass every other rule, so:
   - `matches_request_text`: with a source text, every item quantity must be a number written in it (500 g → 0.5 kg counts). An agent that misreads, or revises a quantity later, needs a human. An agent that sends no source text fails the rule too (nothing to check against); people using the form and recipes are exempt.
   - `usual_quantity`: with at least 3 approved past orders in the same category and unit, a quantity ≥ 3× or ≤ ⅓ of their median needs a human ("usually 200 l"). Demo: the 1,000 l request after three ~200 l orders.
   - Read-back: every proposal shows the original text next to the request as understood. Each field is marked from the text, assumed (date, priorities) or not in the text (quantity, added limit). Computed by rules (`readBack`), so it also checks an outside agent's interpretation.

### 8.1a Confirm what was meant

The path is **Ask → Agent plans → Confirm → You check → Approve → Send to webshop**. The agent plans straight from the words; the proposal then shows what it understood next to them (read-back), with a **Fix** next to every part (products and amounts, date, diets and allergies, priority; portions for recipes).

- `POST /proposals/{id}/confirm`: a person says "this is what I meant" (audit `request_confirmed`). Agents cannot (403).
- `PATCH /proposals/{id}/request`: a person corrects the request; the same proposal is planned again, every check runs again, the confirmation is cleared (audit `request_corrected`). Limits found in the words stay. A correction is a human change: it ends the trust streak.
- Approving a `needs_review` proposal without a confirmation answers 409 `needs_confirmation`, **unless** the person has approved `TRUST_THRESHOLD` (3) proposals in a row without changes: then the step is skipped and the UI says why. Orders the agent finished within policy need no confirmation.

### 8.2 Customer policy (the owner edits)

| Field | Default | Meaning |
|---|---|---|
| `agent_may_finalise` | **false** | Master switch. Off = every proposal needs a human (today's expectation) |
| `max_order_eur` | 500 | Above this, a human signs off even if the switch is on |
| `max_line_eur` | 200 | Same, per line |
| `allow_substitutes` | false | Auto-finalise proposals that contain a substitute. *Not implemented yet: lines are matched to a need, not substituted for a named product; comes with named-product requests* |
| `allow_split` | true | Auto-finalise split lines |
| `allow_unconfirmed_stock` | false | Accept lines Valio reports no stock amount for (E5). Off: such a line waits for a person, with the sure-delivery option next to it |
| `max_over_best_price_pct` | 10 | Chosen option may cost at most this much more per kg/l than the cheapest option sure to arrive (confirmed stock, on time) |
| `weights` | preset | Scoring weights (9.3). *For now the request's `priorities` picks the preset* |

Per-agent key limits are a subset: an agent key can be stricter than the customer policy, never looser.

When `agent_may_finalise` is on, one more check applies: `routine_order`. The agent finishes an order alone only if every item's category and unit has at least 3 approved orders before. Trust earned on milk does not let the agent order fish.

Taking the sure-delivery option the agent offered is not counted as a change for the trust ladder; any other revision is.

### 8.3 Proposal lifecycle

`draft` → (`needs_review` | `auto_approved`) → `approved` → `exported`; also `rejected`, `expired` (cut-off or price validity passed).
`auto_approved` exists only when every policy rule passed. A person can reject it until it is exported; the agent may export it at once, so the pop-up (8.4) is a notice, not a gate.

### 8.4 Trust ladder

The gateway counts approvals in a row that a human made without changing the proposal. After **3**, it suggests letting the agent finish routine orders up to the largest approved total (rounded up to €50): *"You approved 5 proposals in a row without changing them. Let the agent finish routine orders up to €550 on its own?"*

- **Learned from what was accepted**: a soft yes/no rule (`allow_split`, `allow_unconfirmed_stock`) that failed in *every* approval of the streak is switched on in the suggestion ("including orders split across products, as you accepted each time"). Hard rules are never learned.
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
- `customers` (policy as JSON, section 8.2; `agents_enabled` kill switch), `tokens` (customer, role, limits, revoked), `proposals` (request, planned items with options, offers, allocation and verdict as JSON), `audit` (append-only, enforced by triggers; decisions are audit events).

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

Arc: trust is earned in front of the audience, used once, then stopped at its limit. Before: `npm run demo:reset` (two ~200 l milk orders, sure-delivery option taken, approved). Dry run on 2026-11-14 against the live API gave the numbers below.

The whole demo runs in the app (New order page). An outside agent over MCP (Claude Desktop, README) gets exactly the same behaviour; it must pass the person's words as `source_text`, or its proposal always waits for a person.

1. **Request**: type *"I need 200 litres of lactose-free milk by Monday."* The agent plans it.
2. **Human**: Best option 200 × Valio Eila, €202, flagged "Delivery is not confirmed"; next to it the sure-delivery option, 200 × Arla, €496. It waits for you: the policy says a person signs off. Confirm "this is what I meant", click "Use the sure-delivery option", approve (prices re-checked first).
3. **Trust**: that was the third unchanged approval, so the banner appears: "Let the agent finish routine orders up to €500 on its own?" Accept it.
4. **Autonomy**: ask for 200 l again: no "is this what you meant" step, the agent finishes the order on its own from confirmed stock (Arla, €496); the page says "Finished by the agent".
5. **Limit**: the brief's sentence, 1,000 l: the agent stops. "5× your usual amount", over the €500 limit, delivery not confirmed; the sure-delivery option is a split, 384 + 51 + 565 l across three products, €2,580.64. Each line says why.
6. **Other products**: *"10 kg of butter, 25 kg of rice and 20 kg of eggs by Monday"*: one order, three lines, €194.06 (Valio voi, Agrino rice in 10 kg bags, Kieku eggs). It waits for a person ("New for the agent"): trust earned on milk does not cover butter. Not in the recorded cache: needs the live API.
6a. **Stock**: the Stock page shows milk and butter running low. "Let the agent refill 2 items": milk (200 l, routine) is finished by the agent on its own (Arla, €496, pop-up); butter (10 kg, €66) waits: new for the agent, delivery not confirmed. The proposal says why: "3 kg left, about 1.5 kg a day, lasts 2 days, refill to 13 kg". Offers recorded by `npm run record`.
7. *(optional)* **Recipe**: Recipes → a soup → 120 portions → Plan order. Every line traced to the recipe, Valio products named in the recipe used first, a passed cut-off shown on its line.
8. **Path to production**: show the file and the decision record; one line on the webshop's cart import ("Tuo tiedostosta") and where the order API would plug in.

Policy switch worth one sentence: with "Accept products without a confirmed stock amount" on, the agent keeps the cheapest product (Eila) instead of the sure option.

### 11.3 Demo safety

- Record all API responses used by the scenes into `offer_cache` the day before (`npm run record`); the demo reads the cache if the API is slow or down, and says so on screen ("API trouble, cached offers used", which also makes the proposal need a human). `VALIO_TIMEOUT_MS` shortens the wait on a slow network.
- `npm run demo:reset` empties proposals and the decision record and adds two small milk orders approved unchanged, so the third approval, made live, brings up the trust-ladder banner. Demo fixture only.
- `npm run demo` serves the UI and the API from one process.
- Fixed demo clock (`DEMO_NOW`), so cut-offs behave the same at judging time.
- Never touch the shared webshop account during the demo.

---

## 12. Non-functional

- Secrets (`VALIO_API_KEY`, LLM key) only from environment; `.env.example` in the repo.
- API politeness: shortlist only, ≤ 50 ids per call, at most three items planned at a time (two calls each), 429 → 30 s wait and one retry.
- Every query filtered by the caller's customer. Agent keys revocable; admin kill switch.
- Product search < 100 ms; proposal for one item < 3 s with a warm cache.
- The dataset licence allows use for Junction 2026 only. Do not publish it.

---

## 13. Tests (definition of done)

1. Diet/allergen property test over the whole catalogue: no proposal line ever violates the limits.
2. Golden test: the milk request on cached responses gives the expected shortlist, exceptions E2, E5, E6, a stable ranking, the best option (1,000 × Eila, E5) and the sure-delivery option (384 + 51 + 565 l from confirmed stock).
3. Quantity: lot size 0.01 → 1; content from price and content mismatch flagged; split never exceeds known amounts.
4. Policy: each rule at and over its limit; agent key cannot call `decide` (403) and gets no MCP tool for it; alcohol always human.
5. Re-validation: changed cached price → `needs_review` with the difference.
6. 429 handling with a fake server.
7. Export file matches the webshop import format (open question 15.2).

Manual: all scenes twice, once with the model off.

---

## 14. (removed)

Team split and timeline: planning notes, not behaviour. See git history.

---

## 15. Open questions

1. Terminal products return a `closingTime` in the past for a future `availableDate`. Can they be ordered for that date or not? (Ask organisers. Until then: E6.) **High impact:** whole product groups disappear, e.g. 12 of 14 oat breads (all Terminal, cut-off 12 Nov 12:30, available 16 Nov).
2. Exact webshop import file format. Get it by exporting a cart with "Vie Exceliin" and importing a test file into an empty cart at the booth.
3. Is the GS1 allergen code mapping (AM milk, AW gluten, ML lactose, …) confirmed by Valio for this dataset?
4. Hosted LLM allowed for the demo, or local only? (We use Gemini; request text and product names are sent to Google. Voice input on the New order page uses the browser's speech recognition; in Chrome the audio goes to Google too. Confirm with organisers.)
5. Team size, pitch slot and whether judging happens before Sunday 17:00 (the stock cut-off in the mock data).
6. May we use Valio Aimo's public recipes (§4b) in the demo? We keep 15 locally, fetched once, not published.
7. Does "amount unknown" (≥ 999999) carry any real risk of non-delivery? Decides the default of `allow_unconfirmed_stock`.
8. Which stock or kitchen management systems do Valio Aimo customers use, and do they offer an API or an export? (The stock refill in §4c is a mock until then.)
