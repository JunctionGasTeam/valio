# Trusted Trade Agents: product specification

An AI purchasing agent that buys food from Valio Aimo safely, openly and with the right human sign-off.

Version 2.0-draft, 2026-11-14. Replaces v1.1 (kept as `context-v1.1-old.md`).
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
| 2 Lookup | Local search over product data → short list (≤ 30 per item) → one price call and one availability call for that list only |
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
- Allergens use GS1 codes with `CONTAINS`, `MAY_CONTAIN`, `FREE_FROM` (groups `allergen`, `nonAllergen`). **59 % of products have no allergen statement at all**, including obvious ones (a salmon fillet with no fish entry).
- Diet claims live in `nutritionalClaim`: `FREE_FROM_LACTOSE` (4,178), `FREE_FROM_GLUTEN` (3,047), `VEGAN`, `VEGETARIAN`.
- Labels live in `packagingMarkedLabel`: Finnish origin marks, EU organic, MSC, ASC, Fairtrade and more.
- Only 250 substitution pairs exist (product → product). There is no product-type taxonomy.
- Sales units are technical codes (`ST`, `KI`, `PAK`, `KG`, `BOT`…). Pack content comes from `units[].sizeInBaseUnits` and `synkkaData.unitConversions`.
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
| Requester | Chef, kitchen staff, or the buyer's own agent | Basic user | Create requests, view proposals, edit a proposal before approval |
| Approver | Purchasing manager, kitchen manager | Main user (*pääkäyttäjä*) | Everything a requester can, plus approve or reject, edit the policy, grant agent credentials |
| Agent | Any AI agent holding a gateway key | — (new) | Search, check offers, build proposals. **Never approve, never export as approved** |
| Admin | Our team / Valio service desk | — | Kill switch per customer, read all decision records |

An agent key belongs to one customer and carries its own limits (section 8). The first demo customer is a fictional hotel chain, "Hotel Kaisla", with two sites.

---

## 4. Architecture

```
Buyer / buyer's agent ──► Gateway (MCP + REST, one codebase, FastAPI)
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

- **One implementation.** Python backend with FastAPI; REST and the OpenAPI document come from the same routes; MCP tools are thin wrappers over the same functions. A small web UI (React) for the human side. No second engine in the browser.
- **LLM**: two jobs only, turning text into a `PurchaseRequest` and wording the explanation from computed facts. Any OpenAI-compatible or Anthropic endpoint, set by environment. A deterministic fallback parser keeps the product working with the model off. The model never sees or decides prices, eligibility, quantities or policy verdicts.
- **Seam for production**: `OrderSink` has one implementation today (file export). A real order API becomes a second implementation; nothing else changes.

---

## 5. Gateway interface (MCP tools = REST routes)

| Tool / route | Who | Does |
|---|---|---|
| `search_products` · `GET /products/search` | agent, user | Text (fi/en/sv) + filters: free-from allergens, diets, labels, origin, category. Local data only, no API call |
| `get_product` · `GET /products/{id}` | agent, user | Static product data incl. allergens, claims, labels, CO2, reliability |
| `check_offers` · `POST /offers` | agent, user | Price + availability for ≤ 30 ids and a date. Cached. The only route that calls the mock API |
| `create_proposal` · `POST /proposals` | agent, user | Takes a `PurchaseRequest`, runs the planner, returns a proposal with decision record and policy verdict |
| `get_proposal` · `GET /proposals/{id}` | agent, user | Proposal, lines, alternatives, exceptions, verdict |
| `revise_proposal` · `PATCH /proposals/{id}` | agent, user | Change a line (choose another option, change quantity). Re-runs checks |
| `decide` · `POST /proposals/{id}/decision` | **human only** | Approve or reject. Not exposed as an MCP tool. Agent keys get 403 |
| `export` · `GET /proposals/{id}/export` | human, or agent when auto-approved | Webshop import file for an approved proposal |
| `GET /policy`, `PUT /policy` | approver | Customer policy (section 8) |
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

- `unit` is `kg`, `l` or `pcs`. `priorities` picks a weight preset (section 9.3).
- Diet and allergen words found by the keyword detector in `source_text` are always added, even if the model left them out. The model can add a limit, never remove one.
- Missing date → next delivery date whose cut-off has not passed, stated in the proposal. A date in the past → clarification.

---

## 7. Planner rules and exceptions

### 7.1 Steps per item

1. **Find**: full-text search over fi/en/sv names, then category of the top hits to widen the pool. Max 200 local candidates.
2. **Hard filters** (local data, each exclusion recorded with its reason): sales block in data, excluded allergen (`CONTAINS` **or** `MAY_CONTAIN`), required diet not satisfied, required label missing, **no allergen statement while any allergen or diet limit applies** ("allergen data missing"), quantity unit cannot be matched (need in litres, product has no litre content).
3. **Shortlist**: top 30 by text relevance and local criteria.
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

- Content per sales unit (litres or kg) comes from `units[]` × base-unit content in `unitConversions`. If missing, estimate `catalogPrice / comparisonPrice` (checked on real data: 1.0, 5.01, 3.75, 19.94 l) and flag the line `content_estimated`.
- Sales units needed = `ceil(quantity / content)`, rounded up to a multiple of `allowedLotSize` (values below 1 count as 1).
- Allocation: fill from the best-ranked option. If its known amount is short, take the rest from the next option (**split**), up to 3 products per item. Each part keeps its own reason.
- Lines whose `availableDate` is later than `deliver_by` go into a separate delivery date (= separate webshop cart). Never silently.

### 7.3 Exceptions

| # | Exception | Detection | Handling |
|---|---|---|---|
| E1 | No match | No candidate after filters | Unmatched line with reasons; filtered-out list shown |
| E2 | Not deliverable | Empty `scheduleLines` or `salesBlock` | Option dropped; substitutes from the substitution pairs, then same category |
| E3 | Late | `availableDate` > `deliver_by` | Offer "later date" and "substitute on time"; needs human |
| E4 | Partial | Known `availableAmount` < needed | Split across products (7.2); if still short, shortfall stated |
| E5 | Unknown amount | `availableAmount >= 999999` | Allowed, flagged "amount not confirmed"; policy decides (default: human) |
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

### 8.2 Customer policy (approver edits)

| Field | Default | Meaning |
|---|---|---|
| `agent_may_finalise` | **false** | Master switch. Off = every proposal needs a human (today's expectation) |
| `max_order_eur` | 500 | Above this, a human signs off even if the switch is on |
| `max_line_eur` | 200 | Same, per line |
| `allow_substitutes` | false | Auto-finalise proposals that contain a substitute |
| `allow_unknown_amount` | false | Auto-finalise lines with E5 |
| `allow_split` | true | Auto-finalise split lines |
| `max_over_best_price_pct` | 10 | Chosen option may cost at most this much more per kg/l than the cheapest eligible one |
| `weights` | preset | Scoring weights (9.3) |

Per-agent key limits are a subset: an agent key can be stricter than the customer policy, never looser.

### 8.3 Proposal lifecycle

`draft` → (`needs_review` | `auto_approved`) → `approved` → `exported`; also `rejected`, `expired` (cut-off or price validity passed).
`auto_approved` exists only when every policy rule passed; it is still undoable until export.

### 8.4 Trust ladder

When automation is off for a rule, the UI counts approvals in a row that a human made without changing the proposal. After 5, it suggests: *"You approved 5 milk orders unchanged. Let the agent finalise orders under €500?"* A change or a rejection resets the count. The suggestion never changes the policy itself. This is Valio's own path ("may be dropped if reliability is good enough") made measurable.

### 8.5 Decision record

For each proposal: the request, filters with excluded products and reasons, shortlist, the raw price and availability responses (with fetch time), scores per criterion, allocation, exceptions, policy results per rule, the human decision with time and user, and the export file hash. Append-only. Shown as a readable timeline and exportable as JSON.

---

## 9. Scoring

Only eligible, deliverable options are scored. All criteria are 0..1, higher is better.

| Criterion | Score | Default weight |
|---|---|---|
| Price | lowest `comparisonPrice` ÷ this one | 0.40 |
| Availability | 1 = on time and known amount covers the need; 0.7 = on time, amount unknown; 0.4 = on time, partial | 0.25 |
| Reliability | value from the file; missing → vendor mean; else 0.9 | 0.15 |
| CO2 | lowest kg CO2e/kg ÷ this one; missing → criterion skipped, weights rescaled | 0.10 |
| Origin and labels | 1 if `fi` or a Finnish origin mark; +0.5 per required/preferred label, capped at 1 | 0.10 |

Ties: lower total cost, then product id. Weight presets: `price_and_availability` (above), `sustainability` (CO2 0.30, price 0.30), `reliability_first` (reliability 0.35).

---

## 10. Data model (SQLite)

- `products` (from the JSON, flattened): id, gtin, names fi/en/sv, vendor, category, origin, sales unit, lot size, content per sales unit + unit, allergens contains/may/free (JSON), claims, labels, temperature class, co2, reliability. `products_fts` over names.
- `substitutions` (product, substitute).
- `offer_cache`: endpoint, product, date, response JSON, fetched_at.
- `customers`, `sites`, `users` (role), `agent_keys` (customer, limits, revoked).
- `policies` (section 8.2), `proposals`, `proposal_lines` (option chosen, alternatives JSON, exceptions, frozen price + validity), `decisions`, `audit` (append-only).

Money in integer cents ex-VAT; VAT rate stored per line from the API.

---

## 11. Demo

### 11.1 Fixed facts (checked against the API on 2026-11-14, date 2026-11-16)

30 lactose-free milk products pass the filters. Examples:

| Product (dataset id) | Model | Amount | €/l |
|---|---|---|---|
| Valio Arki Eila kevytmaitojuoma 1 l (464306) | Stock | unknown (≥ 999999) | 1.01 |
| Valio Eila rasvaton maitojuoma 1 l (464401) | Stock | unknown | 1.10 |
| Arla Kevytmaitojuoma 1 L (469363) | Stock | 384 | 2.48 |
| Arla Maitojuoma 1 L rasvaton (462775) | Stock | 51 | 2.57 |
| Valio kevytmaito 0,5 l (464440) | — | not available | — |

Stock products have cut-off 15 Nov 17:00; Terminal products report 12 Nov (E6).

### 11.2 Scenes (3 minutes)

1. **Request (outside agent)**: in Claude Desktop, connected to our gateway over MCP, say the brief's sentence. The agent calls `search_products`, `check_offers`, `create_proposal`. Point: an outside agent works through an open standard.
2. **Proposal**: open the approval UI. 1,000 l of the cheapest option, flagged "amount not confirmed" (E5); the 0.5 l product is listed as not available (E2); Terminal products dropped for a passed cut-off (E6). Each line has its reason.
3. **Guardrail**: the agent tries to finalise; the gateway answers `requires_human` (policy: unknown amount, over €500). The agent tells its user so.
4. **Human**: the approver switches to "confirmed stock only": the planner splits 384 + 51 l and states the shortfall, or keeps the unknown-amount option. Approve. Export the file.
5. **Path to production**: show the file and the decision record; one line on importing it into today's webshop cart ("Tuo tiedostosta") and where the order API would plug in. Trust ladder banner as the closing line.

### 11.3 Demo safety

- Record all API responses used by the scenes into `offer_cache` the day before; the demo reads the cache if the API is slow, and says so on screen.
- Fixed demo clock (`DEMO_NOW`), so cut-offs behave the same at judging time.
- Never touch the shared webshop account during the demo.

---

## 12. Non-functional

- Secrets (`VALIO_API_KEY`, LLM key) only from environment; `.env.example` in the repo.
- API politeness: shortlist only, ≤ 30 ids per call, client throttle 5 calls/s, 429 → 30 s wait.
- Every query filtered by the caller's customer. Agent keys revocable; admin kill switch.
- Product search < 100 ms; proposal for one item < 3 s with a warm cache.
- The dataset licence allows use for Junction 2026 only. Do not publish it.

---

## 13. Tests (definition of done)

1. Diet/allergen property test over the whole catalogue: no proposal line ever violates the limits.
2. Golden test: the milk request on cached responses gives the expected shortlist, exceptions E2, E5, E6, and a stable ranking.
3. Quantity: lot size 0.01 → 1; content estimate flagged; split never exceeds known amounts.
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
| B · Gateway | FastAPI routes, MCP server, offer client + cache + 429, policy engine, audit, export |
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

1. Terminal products return a `closingTime` in the past for a future `availableDate`. Can they be ordered for that date or not? (Ask organisers. Until then: E6.)
2. Exact webshop import file format. Get it by exporting a cart with "Vie Exceliin" and importing a test file into an empty cart at the booth.
3. Is the GS1 allergen code mapping (AM milk, AW gluten, ML lactose, …) confirmed by Valio for this dataset?
4. Hosted LLM allowed for the demo, or local only?
5. Team size, pitch slot and whether judging happens before Sunday 17:00 (the stock cut-off in the mock data).
