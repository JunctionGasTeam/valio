Trusted Trade Agents: product specification
AI agents for foodservice purchasing that find products, compare options and handle surprises, while people stay in control.
Version 1.1-draft, written 2026-11-12. Status: final draft for review, no code exists yet.
Merged from `SPEC.md` (product framing, 2026-11-04) and `SPEC2.md` (build specification, 2026-11-12). Where they disagree, this file decides.
1.1: adds spoken food orders through local speech recognition (story F8, section 12.6).
This file is the source of truth for behaviour. When behaviour changes, change this file first, then the code.
1. Summary, problem and challenge fit
1.1 Summary
A restaurant chef types or says what they need in plain language. Speech is transcribed on the customer's own hardware, and the chef checks the transcript before anything happens. Software agents find matching products in the wholesaler's catalogue, compare the options and build a draft order. If something goes wrong later (a stock-out, a price rise, a late delivery, a recall), the agents work out which orders are affected and propose a fix. A person confirms every order. A person also decides every change that falls outside the limits the customer has set.
The agents work in two halves:
Buyer side (works for the restaurant): Intake, Finder, Comparator and Guard. It reads the request, applies the customer's limits and preferences, ranks options and checks each proposed change against the customer's policy.
Seller side (works for the wholesaler): Disruption. It owns the catalogue, the substitution map and incoming events. It finds affected order lines and makes structured proposals (substitute, keep, wait, remove).
The halves exchange structured proposals, not free text, so every step can be checked and logged. There is no open-ended negotiation loop. A proposal is either applied automatically inside the customer's policy or decided by a person (section 7).
The language model is small and runs on the customer's or wholesaler's own hardware. Its only jobs are reading the request and wording the explanation. A separate local speech model only turns speech into text. Ordinary code computes everything that affects safety or money.
1.2 Problem
Ordering takes too long. Chefs place repeat orders several times a week, often late after service, and rebuild near-identical baskets each time. Their hands are often busy or wet, so typing on a kitchen tablet is slow.
Comparing options is hard. Price per kg, pack size, allergens, origin and supplier reliability sit on separate product pages and are rarely compared side by side.
Surprises break service. Stock-outs, price changes, delays and recalls are often found too late, sometimes only when the truck arrives. For the wholesaler, each disruption means a burst of manual calls to many customers.
People don't trust automation. A wrong item, a missed allergen or an overspend hurts guests and margins. Without transparency, limits and undo, nobody adopts automation.
1.3 Challenge fit
Challenge phrase
What the product does
Stories
Find products
A typed or spoken request, dish name or "the usual" becomes a list of matched catalogue products. Allergen, diet and banned-product limits are hard filters
F1-F8
Compare options
Every line has a ranked comparison. The score is broken down per criterion, and a list shows what was filtered out and why
C1-C5
Handle surprises
Stock-out, price change, delivery delay and recall events are matched to open orders and turned into proposals
S1-S5
People stay in control
The agent never confirms an order. Changes apply automatically only inside a policy that the customer edits, per event type. Everything is logged, and automatic changes can be undone
H1-H8
There are two deliverables built from one codebase:
Product: FastAPI backend, React frontend, local language model, local speech model.
Demo: the same React UI, built as static files, with a scripted agent running in the browser. It has no backend and no language model. Speech is transcribed in the browser by a bundled speech model (section 14).
2. Goals, non-goals and success metrics
2.1 Goals
G1: Make ordering fast. A recurring or ad-hoc order takes minutes.
G2: Make comparison effortless. Every recommendation comes with a side-by-side breakdown and a reason built from computed facts.
G3: Handle surprises early. Disruptions are matched to orders and proposals are made before the cut-off, inside limits that people set.
G4: Earn trust. People can see, approve, change and undo what agents do. Automation grows only when a person switches it on.
2.2 Non-goals
Fully autonomous buying. No agent confirms an order (H1).
Multi-supplier marketplace. Only the wholesaler's assortment is used.
Menu planning. Agents read stored recipes but never design menus.
Price negotiation. Agents work only with contract prices.
2.3 Success metrics
Baselines are assumptions to check with real data. All metrics can be computed from the audit log (section 7.4). There is no dashboard in this release.
Metric
Definition
Baseline (assumed)
Target
Time per order (G1)
Time from the first chat message to confirm for a draft order
~20 min
≤ 5 min
Recommendation acceptance (G4)
Share of comparisons and proposals where the person chose the recommended option
n/a
≥ 70 %
Revert rate (G4)
Share of automatic changes that are reverted
n/a
≤ 3 %
Voice transcript edit rate (G1)
Share of voice requests where the person edited the transcript before sending
n/a
≤ 30 %
Disruptions settled in-app (G3)
Share of affected order lines that are resolved before the cut-off without "contact the sales service"
~0 %
≥ 70 %
Guardrail metric: zero allergen or diet violations in drafts, options or applied changes.
3. Users and jobs
All people and the restaurant below are fictional.
Role
Example
Normal day
Bad day
Buyer (chef)
Head chef at Ravintola Kaisla, a 60-seat restaurant in Tampere
Orders for the next delivery day in a few minutes between services, often by speaking to the kitchen tablet. Wants known products at the contract price
A product is missing from tomorrow's delivery and they find out when the truck arrives
Approver (owner or kitchen manager)
Owner of the same restaurant
Sets spending, substitution and automation limits. Confirms large orders
Has to decide quickly on a more expensive substitute before the order cut-off
Admin
The wholesaler's customer service person, or the developer
Manages users, feeds in events, exports decision logs. Can pause automation for the customer (kill switch)
Needs to show exactly what the agent did and why
Future seller-side users (not built in this release, see section 4.2): a key account manager who sets substitution rules and offers per customer, a supply planner who sets allocation rules during shortages, and a customer service queue for exceptions across all customers.
4. Scope and roadmap
4.1 This release
In for the pitch (demo build): the scenes in section 14, catalogue search, comparison view, approval inbox, policy panel, audit timeline and reset.
In for the production core: everything in sections 5 to 13 and 15, with login, roles, persistence, audit log, tests, and the local model with fallback.
Out, for now:
Any connection to real Valio Aimo systems. Catalogue and orders sit behind `CatalogProvider` and `OrderProvider` interfaces with a local SQLite implementation.
Payments, invoices and VAT. All prices are shown excluding VAT.
Email, SMS or push notifications. Notifications appear in the app only.
Mobile app and barcode scanning.
Hands-free voice: wake words, always-on listening, spoken replies (text-to-speech) and voice commands for approvals or confirmation. Voice in this release is push-to-talk dictation into the chat box only (F8).
Storing audio recordings. Audio is discarded after transcription.
Running a fine-tune. The data export and the script are prepared (section 16).
More than one customer in the seed data. The data model does carry `customer_id` everywhere.
Finnish or Swedish user interface. The UI is in English. Product names are stored in Finnish and English.
4.2 Roadmap
Release 2
Customer service exception queue across all customers, with one-click resolution
Weekly budget cap alongside the per-order limit
Short or wrong delivery claims, by chat or a photo of the delivery note
Real Valio Aimo integrations (catalogue, stock, pricing, orders, delivery) behind the existing provider interfaces
KPI dashboard built on the metrics in section 2.3
Finnish and Swedish UI
Later
Key account guardrail editor per customer or segment (substitution rules, authorised offers)
Allocation rules for shortages, applied the same way to every affected customer
Restaurant chains and multi-site approval chains, then public-sector and catering kitchens
Hands-free voice (wake word, spoken read-back of the draft) and messaging-app channels, including voice messages
Speech model tuned on kitchen vocabulary and noise, using the transcript corrections logged in section 16
Order cut-off reminders with the draft ready
5. User stories and acceptance criteria
Find
F1. Order by dish. As a buyer, I type "salmon soup for 80 on Friday, lactose-free" and get a draft order.
The dish is matched to a stored recipe. Each ingredient quantity is the recipe quantity per portion times the number of portions.
Each ingredient becomes one draft line with a chosen product, a number of packs and a cost.
The draft has status `draft`. Nothing has been sent anywhere.
F2. Order by item list. As a buyer, I type "10 kg potatoes, 5 l cooking cream and butter".
Each item becomes a draft line.
An item with no quantity gets 1 pack, and the line is flagged `quantity_assumed`.
F3. Hard limits. Allergen and diet limits in the request are never broken.
A product that contains an excluded allergen, or lacks a required diet flag, never appears as a line or as an option.
Limits found by the keyword detector are always applied, even if the model's output left them out (section 12.3).
"Lactose-free" is a diet flag. It does not exclude the milk allergen. "No milk" or "milk allergy" does.
Missing data counts as non-compliant. If a request has any allergen or diet limit, a product with unknown allergens or unknown diet flags is excluded with the reason "allergen data missing".
F4. Honest gaps. When nothing matches an item, the draft shows an unmatched line with the reason. The agent never substitutes a different kind of product without saying so.
F5. Search. As a buyer, I can search the catalogue directly with text and filters: allergens to exclude, diet flags, product group, and deliverable by date.
Search works on Finnish and English product names and through the synonym table.
Banned products are shown in search results with a "banned" tag and cannot be added to a draft.
F6. Reorder the usual. As a buyer, I type "the usual for Friday" and get a draft built from my order history.
The base set is the customer's confirmed orders from the last 8 weeks whose delivery date falls on the same weekday as the target date. If there are fewer than 3 such orders, all confirmed orders from the last 8 weeks are used.
A product is included if it appears in at least 50 % of the orders in the base set. Its packs are the median packs across the orders that contain it, rounded up.
Each line is flagged `from_history`.
Every history line still goes through Finder's rules (section 6.2) with the request's limits. If the product fails a rule (blocked, out of stock, banned, allergen or diet, not deliverable), the line is unmatched with that reason. The comparison for that line lists eligible products of the same type. Nothing is swapped in silently.
The request can be combined with others: "the usual plus salmon soup for 80". The lines from each source stay separate and are labelled by source.
An empty base set gives the reply "No order history yet" and two example requests.
F7. Preferred and banned products. As a buyer or approver, I can mark a product as preferred or banned.
A banned product is a hard exclusion in Finder, with the reason "banned by customer".
A preferred product counts as familiar (familiarity = 1) even without history, and gets a "preferred" tag. No other score changes.
Marking a product as banned does not change lines already in a draft. It affects new drafts, comparisons and substitutes.
Every change is written to the audit log.
F8. Order by voice. As a buyer, I hold the microphone button, say "lohikeittoa kahdeksallekymmenelle perjantaiksi, laktoositon" or "salmon soup for 80 on Friday, lactose-free", and get the same draft as if I had typed it.
Voice is push-to-talk: recording runs while the button (or the `Space` key with the chat box focused) is held, or between two taps in tap mode. A recording stops by itself after 30 seconds.
Speech is transcribed locally (section 12.6). Finnish and English are recognised, and the language is detected per recording.
The transcript is never sent on its own. It is placed in the chat box, where the buyer can read and edit it, and goes to Intake only when the buyer presses Send. Words the speech model was unsure of are underlined.
Allergen and diet words in the transcript (from the keyword table, section 12.4) are highlighted, so a misheard or missing "lactose-free" is easy to spot before sending.
From Send onwards the text goes through exactly the same path as typed text: Intake, keyword detector, Finder, Guard. Voice adds no shortcut and lowers no limit.
If nothing intelligible was heard, the reply is "I didn't catch that. Try again or type your order." Nothing is placed in the chat box.
If speech recognition is unavailable (no microphone permission, no microphone, model not loaded), the microphone button is disabled with the reason as a tooltip. Typing always works.
The order records `input_mode: voice`. The audit log keeps the raw transcript and the text actually sent. The audio itself is not stored.
Compare
C1. Ranked options. Every draft line can be opened to show all eligible products for that need, ranked by score. Each option shows: price per pack, price per kg or litre, packs needed, total cost, leftover quantity, origin, CO2 estimate, supplier reliability, and whether the customer has bought it before or marked it preferred.
C2. Reasons. The view shows the score per criterion for each option and one or two sentences on why the top option was picked. Every number in that text comes from computed data.
C3. Filtered out. The view lists the products that were excluded and the rule that excluded each one, for example "not lactose-free", "cannot be delivered by Fri 20 Nov" or "banned by customer".
C4. Override. The buyer can pick any eligible option instead of the recommended one. The override is recorded in the audit log with the rank of the chosen option.
C5. Prefer or ban from the comparison. Each option has "Prefer" and "Ban" actions (F7). After either action the comparison is recomputed.
Surprises
S1. Stock-out. When a product in an open order becomes unavailable for the delivery date, a proposal is created with three kinds of option: ranked substitutes, "wait" if a restock date is known, and "remove line".
S2. Price change. A price rise up to the policy limit is acknowledged automatically and logged, as long as automation is on for price changes. A larger rise creates a proposal with "keep at new price", substitutes and "remove line". A price drop is applied and logged.
S3. Delivery delay. When a supplier delay means a line cannot arrive on the delivery date, it is handled like a stock-out, with the new arrival date as the "wait" option.
S4. Recall. The product is blocked in the catalogue at once. Every open order that contains it gets a proposal, and that proposal always needs a person. Orders delivered in the last 14 days that contained the product produce a notification naming the batch.
S5. Inside the limits. A substitution that passes every rule in the autonomy policy is applied automatically. It is shown as a notification with an Undo button and logged.
Human control
H1. Only people confirm. An order is confirmed only when a person calls the confirm action. No agent code path can confirm an order.
H2. Spending limit. A buyer can confirm an order up to the policy's order limit. Above that limit, the order moves to `awaiting_approval` and an approver confirms it.
H3. Approval inbox. Pending proposals are listed. Each shows the trigger, the affected order line, the options, the recommended option, the rules that passed and failed, and the time left before the order cut-off.
H4. Decide. A person can approve the recommended option, approve a different option, or reject. Sending the same decision twice returns the same result. A second, conflicting decision is refused.
H5. Undo. An automatically applied change can be reverted while the order can still be edited. Reverting restores the original line and turns the proposal back into a pending one.
H6. Policy. An approver can view and edit the autonomy policy (section 7.3), including automation per event type. Two rules cannot be switched off: recalls always need a person, and a substitute that adds an allergen is never applied automatically.
H7. Audit. Every agent step, guard decision, human decision, policy change, preference change and login is stored with time, actor and data. The audit timeline for an order shows the whole chain in order.
H8. Trust suggestion (Should). When automation is off for an event type, the inbox counts how many proposals in a row for that type a person approved with the recommended option. After 5, the inbox shows "You approved the recommended option 5 times in a row for stock-outs. Turn on automatic handling?" Any reject, or any choice of a different option, resets the count to zero. The suggestion never changes the policy; only an approver's edit does, and that edit is logged as usual.
6. Agents
The agents are plain Python functions that an orchestrator runs in sequence. None of them loops or picks its own tools.
Side
Agent
Owns
Buyer
Intake, Finder, Comparator, Guard
Reading the request, customer limits, preferences, ranking, policy verdicts
Seller
Disruption
Events, affected lines, substitution map, proposal options
6.1 Intake (buyer)
Input: chat text (typed, or a voice transcript the person has reviewed and sent), customer, current time. Intake does not treat the two differently.
Output: a validated `PurchaseRequest` (section 12.2), plus a flag saying whether the model or the fallback produced it.
Rules:
Call the model with the parse prompt and validate the reply against the schema.
On a timeout, connection error, invalid JSON or schema failure, use the fallback parser. Do not retry.
Run the keyword detector on the original text and add any allergen or diet limits it finds to the result.
If a dish is named, match it to a recipe by name or alias. If the dish is unknown, ask the user to list the ingredients.
If `reorder` is true, build history lines as described in F6.
If there is no delivery date, use the next delivery day whose cut-off has not passed, and say so in the reply.
If the date is in the past or is not a delivery day, ask for a date and offer the next two delivery days.
Escalate on uncertainty. If the model and the fallback disagree on the dish, the date or the portions, ask a clarification question with both readings as choices. Do not guess.
Failure: if neither path produces a usable request, reply with what the agent can do and two example requests.
6.2 Finder (buyer)
Input: one needed item (query text or product type, quantity, unit), limits, delivery date, customer preferences.
Output: eligible candidates, plus a list of excluded products with reasons.
Rules:
Candidates come from the product type when it is known (recipe ingredients and history lines carry one). Otherwise they come from full-text search over the Finnish name, English name and synonyms.
Exclude, with a recorded reason:
blocked (recalled) products
banned products
products with an excluded allergen
products missing a required diet flag
products with unknown allergens or diet flags, when any limit applies
products with less stock than the packs needed
products whose earliest delivery is after the delivery date
A unit mismatch (the need is in kg, the product is sold by the litre) excludes the product. There is no unit conversion between kg, l and pieces.
Failure: if no candidates are eligible, the line is unmatched (F4).
6.3 Comparator (buyer)
Input: eligible candidates, needed quantity, customer weights, history and preferences.
Output: candidates ranked by score, with the per-criterion breakdown. The formula is in section 11.
Failure: if there is only one candidate, the comparison is still shown, marked "only option".
6.4 Disruption (seller)
Input: one event (section 8, `events`).
Output: zero or more proposals.
Rules:
Affected lines are lines for the product (or the supplier's products) in orders with status `draft`, `awaiting_approval` or `confirmed`, whose delivery date falls in the affected period and whose cut-off has not passed.
Substitute candidates are products whose type is listed for the original product's type in `substitution_map`. They are run through Finder with the order's limits and the customer's preferences, then through Comparator.
A substitute that contains an allergen the original product did not contain, or whose allergens are unknown, is kept out of the ranking. It is shown in a separate "adds allergens" list with a warning and is never the recommended option.
Every proposal also offers "remove line", and "wait" when a restock or arrival date is known.
Orders past their cut-off get a notification only: "contact the sales service".
One event produces at most one proposal per order line. Sending the same event again creates nothing new.
6.5 Guard (buyer)
Input: a proposal with its recommended option, and the customer policy.
Output: a list of rule results (rule, passed, actual value, limit) and a verdict: `auto_apply` or `needs_approval`.
Rules: see section 7.3. Every rule must pass for `auto_apply`. Limits are inclusive: exactly 5.0 % passes a 5.0 % limit.
Automation master switch is on.
Automation is on for this event type (`auto_enabled_by_event`). Recall is always off.
Price increase ≤ `max_price_increase_pct`.
Line value after the change ≤ `max_auto_line_value_cents`.
Same product group, if `require_same_product_group`.
No added or unknown allergens.
The order total after the change stays within `order_limit_cents` if the order is already `confirmed`.
Failure: any error during evaluation gives `needs_approval`.
7. Human-control model
7.1 Hard rules (never broken, at any setting)
Allergens and diets. No line, option or applied change breaks the request's allergen or diet limits. Unknown data counts as non-compliant.
People confirm orders. No agent code path confirms an order (H1).
Spend limit. A buyer cannot confirm, or approve a change that takes an order, above the order limit (H2).
Recall and added allergens need a person. These cannot be switched off (H6).
Explain every action. Every option and proposal carries a reason built from computed facts. Every automatic change can be undone until the cut-off (H5).
Escalate on uncertainty. If the parse is ambiguous or conflicting, the agent asks a question (6.1 rule 8). Guard errors give `needs_approval`.
People see what the agent heard. A voice transcript is never acted on until the person has seen it and pressed Send (F8). Voice can never confirm an order or decide a proposal.
7.2 Lifecycles
Order
From
Action
By
To
(none)
Intake creates a draft
agent
`draft`
`draft`
edit, add or remove a line
buyer, approver
`draft`
`draft`
confirm, total within limit
buyer, approver
`confirmed`
`draft`
confirm, total over limit
buyer
`awaiting_approval`
`awaiting_approval`
confirm
approver
`confirmed`
`awaiting_approval`
send back
approver
`draft`
`draft`, `awaiting_approval`, `confirmed`
cancel, before cut-off
buyer, approver
`cancelled`
Proposals can still change a confirmed order until its cut-off. After the cut-off, nothing can change it.
Proposal
From
Action
By
To
(none)
Guard verdict `needs_approval`
agent
`pending`
(none)
Guard verdict `auto_apply`
agent
`auto_applied`
`pending`
approve (any eligible option)
buyer or approver (see below)
`approved`
`pending`
reject
same
`rejected`
`pending`
order cut-off passes
system
`expired`
`auto_applied`
revert, before cut-off
buyer, approver
`pending`
A buyer can approve a proposal unless the change would take the order total over the order limit. In that case only an approver can approve it.
7.3 Autonomy policy
There is one policy per customer.
Field
Default
Editable
Meaning
`auto_substitute_enabled`
true
yes (approver, admin)
Kill switch. Off means every proposal needs a person. An admin can flip it to pause automation for the customer
`auto_enabled_by_event`
`{stock_out: true, price_change: true, delivery_delay: true}`
yes
Automation per event type. Off means proposals of that type always need a person
`max_price_increase_pct`
5.0
yes, 0 to 25
Largest rise in line cost that may be applied or acknowledged automatically
`max_auto_line_value_cents`
10000
yes
Lines costing more than this after the change always need a person
`require_same_product_group`
true
yes
Automatic substitutes must be in the same product group as the original
`order_limit_cents`
50000
yes
Largest order total a buyer may confirm alone
`weights`
section 11
yes, must sum to 1.0
Comparator weights
Recalls need a person
always
no
Substitutes that add an allergen need a person
always
no
Order confirmation by a person
always
no
7.4 Audit
Each entry stores: time (UTC), actor type (`agent`, `user`, `system`), actor id, action, order id, proposal id, a JSON payload with inputs and outputs, and for agent steps whether the model or the fallback was used. For a voice request, a `speech_transcribed` entry stores the raw transcript, detected language, average confidence, duration and speech model name, and the chat entry stores the sent text and whether it was edited. The API never updates or deletes entries.
8. Data model
Money is stored as integer euro cents, excluding VAT. Quantities are decimals with 3 places in the product's base unit. Times are UTC in the database and shown in Europe/Helsinki time.
suppliers: `id` text PK, `name`, `country` (ISO 3166 alpha-2), `reliability` (0 to 1, the share of lines delivered on time and in full).
products: `id` text PK, `name_fi`, `name_en`, `supplier_id` FK, `product_group`, `product_type`, `base_unit` (`kg`, `l`, `pcs`), `pack_size` decimal > 0, `list_price_cents`, `contract_price_cents` (per pack), `allergens` (JSON list of values from section 9.3; null means unknown), `diet_flags` (JSON list; null means unknown), `origin_country`, `co2_kg_per_unit` decimal, `stock_packs` integer >= 0, `lead_time_days` integer >= 1, `restock_date` nullable, `is_blocked` boolean, `ean`.
product_fts: an SQLite FTS5 index over `name_fi`, `name_en` and synonyms.
synonyms: `term`, `product_type`. Example: "kerma", "cream" and "cooking cream" map to `cooking_cream`.
substitution_map: `product_type`, `substitute_type`, unique together. Every type is listed as its own substitute.
recipes: `id`, `name_fi`, `name_en`, `aliases` (JSON list). recipe_items: `recipe_id`, `product_type`, `quantity_per_portion`, `unit`.
customers: `id`, `name`, `delivery_weekdays` (JSON list, 0 = Monday), `cutoff_time` (local time on the working day before delivery), `timezone`.
users: `id`, `customer_id`, `email` unique, `display_name`, `role` (`buyer`, `approver`, `admin`), `password_hash` (Argon2id), `is_active`.
policies: `customer_id` PK, the fields from section 7.3, `updated_by`, `updated_at`.
product_preferences: `customer_id`, `product_id`, `kind` (`preferred`, `banned`), `created_by`, `created_at`. Unique on (`customer_id`, `product_id`).
orders: `id`, `customer_id`, `status`, `delivery_date`, `cutoff_at`, `constraints` (JSON: excluded allergens, diet flags), `source_text` (the original request as sent), `input_mode` (`text`, `voice`), `created_by`, `confirmed_by`, `confirmed_at`, `total_cents`, `created_at`, `updated_at`.
order_lines: `id`, `order_id`, `need_label`, `source` (`dish`, `items`, `history`, `manual`), `product_type` nullable, `needed_quantity`, `unit`, `product_id` nullable (null means unmatched), `packs`, `pack_price_cents` (the price at the time of choice), `line_cents`, `flags` (JSON: `quantity_assumed`, `unmatched`, `human_override`, `from_history`, `preferred`), `unmatched_reason`, `comparison` (a JSON snapshot of options and exclusions at the time of choice).
order_history: past confirmed lines per customer (`customer_id`, `order_id`, `product_id`, `delivery_date`, `packs`). Used for the familiarity criterion and for F6. Confirmed orders are added to it.
events: `id`, `type` (`stock_out`, `price_change`, `delivery_delay`, `recall`), `product_id` nullable, `supplier_id` nullable, `payload` (JSON), `dedupe_key` unique, `received_at`, `processed_at`.
Payloads: `stock_out` {`restock_date` or null}; `price_change` {`new_contract_price_cents`}; `delivery_delay` {`delay_days`}; `recall` {`batch`, `reason`}.
proposals: `id`, `customer_id`, `order_id`, `order_line_id`, `event_id`, `event_type`, `status`, `options` (JSON list: id, kind `substitute` / `keep` / `wait` / `remove`, product id, packs, line cost, score breakdown, warnings), `recommended_option_id`, `chosen_option_id`, `guard_results` (JSON), `explanation`, `expires_at`, `decided_by`, `decided_at`, `comment`, `created_at`. Unique on (`event_id`, `order_line_id`). The H8 counter is computed from this table and is not stored.
audit_log: the fields from section 7.4, with an increasing `id`.
9. Synthetic data specification
There is no data from Valio. All data is generated by `data/generate_seed.py` with a fixed random seed (20261112), so two runs give byte-identical JSON. The JSON files in `data/seed/` are committed, and both the backend and the demo read them.
9.1 Rules
Suppliers are fictional. No real brand names or real prices are used. The UI footer and the README say the catalogue is synthetic.
CO2 values are illustrative numbers in a plausible range. They are not life-cycle assessment data.
Contract price is list price minus a discount of 3 to 12 %, fixed per product group.
Every product type used by a recipe has at least 3 products from at least 2 suppliers.
About 5 % of products have zero stock and about 10 % have a lead time of 2 or 3 days, so that the filters visibly do something.
Exactly 3 products have unknown allergens (`allergens: null`). None of them is in a product type used by salmon soup, so that the worked examples and scenes are unaffected.
No preferences or bans are seeded.
The products named in section 9.5 are pinned: they have fixed ids and values, written by hand in the generator and never randomised.
9.2 Catalogue: 300 products, 12 suppliers
Product group
Products
`dairy`
45
`vegetables_fresh`
40
`dry_goods`
35
`meat_fresh`
30
`bakery`
20
`stocks_sauces`
20
`vegetables_frozen`
20
`fish_fresh`
15
`fish_frozen`
15
`poultry`
15
`fruit`
15
`oils_fats`
12
`herbs_spices`
12
`eggs`
6
9.3 Allowed values
Allergens (the 14 EU allergens): `gluten`, `crustaceans`, `eggs`, `fish`, `peanuts`, `soy`, `milk`, `nuts`, `celery`, `mustard`, `sesame`, `sulphites`, `lupin`, `molluscs`.
Diet flags: `lactose_free`, `low_lactose`, `gluten_free`, `vegan`, `vegetarian`, `organic`.
The generator enforces these consistency rules:
`vegan` implies no `milk`, `eggs`, `fish`, `crustaceans` or `molluscs`.
`gluten_free` implies no `gluten`.
`lactose_free` is only set on products that contain `milk` or are vegan.
9.4 Customer, users and history
Customer: Ravintola Kaisla. Delivery weekdays are Tuesday, Thursday and Friday. The cut-off is 14:00 on the working day before delivery.
Users: one buyer, one approver and one admin, with `@kaisla.example` addresses. Development passwords come from environment variables.
10 recipes, including salmon soup (section 9.5).
8 weeks of order history, about 2 orders a week, built from the recipes. Friday orders share a stable core of at least 8 products, so that "the usual for Friday" gives a recognisable draft.
4 prepared events for the demo (section 14).
9.5 Pinned fixtures
Salmon soup (`lohikeitto`), per portion: salmon fillet 0.100 kg, potato 0.150 kg, carrot 0.040 kg, leek 0.030 kg, cooking cream 0.0625 l, fish fond 0.0125 l, butter 0.010 kg, fresh dill 0.005 kg.
Id
Product
Group / type
Pack
Contract price
Origin
Supplier reliability
CO2 per unit
Allergens
Notes
P-FISH-001
Lohifilee tuore / Fresh salmon fillet
`fish_fresh` / `salmon_fillet`
2 kg
€29.80
NO
0.93
5.1
fish
Bought before
P-FISH-002
Kirjolohifilee tuore / Fresh rainbow trout fillet
`fish_fresh` / `trout_fillet`
2 kg
€33.40
FI
0.95
4.5
fish
P-FZF-001
Lohikuutio pakaste / Frozen salmon cubes
`fish_frozen` / `salmon_cubes_frozen`
1 kg
€13.50
NO
0.92
5.4
fish
P-DAI-001
Ruokakerma 15 % laktoositon / Cooking cream 15 % lactose-free
`dairy` / `cooking_cream`
1 l
€3.20
FI
0.97
2.9
milk
`lactose_free`. Bought before
P-DAI-002
Same product, large pack
`dairy` / `cooking_cream`
2 l
€5.90
FI
0.97
2.9
milk
`lactose_free`
P-DAI-003
Imported cooking cream 15 % lactose-free
`dairy` / `cooking_cream`
1 l
€2.85
DE
0.90
3.4
milk
`lactose_free`
P-DAI-004
Ruokakerma 15 % / Cooking cream 15 %
`dairy` / `cooking_cream`
1 l
€2.60
FI
0.97
2.9
milk
Not lactose-free
P-STK-001
Kalafondi / Fish fond
`stocks_sauces` / `fish_fond`
1 l
€9.80
FI
0.96
1.8
fish
Bought before
P-STK-002
Kalafondi tiiviste / Fish fond concentrate
`stocks_sauces` / `fish_fond`
1 l
€10.15
FI
0.94
1.9
fish
P-STK-003
Kala-äyriäisfondi / Fish and shellfish fond
`stocks_sauces` / `fish_fond`
1 l
€9.20
SE
0.94
2.1
fish, crustaceans, celery
Substitution map entries: `salmon_fillet` maps to `salmon_fillet`, `trout_fillet` and `salmon_cubes_frozen`.
10. API contract
Base path `/api`. JSON in and out. All routes except login and health need `Authorization: Bearer <token>`. Every query is limited to the customer in the token.
Errors: `{"error": {"code": "string", "message": "text for people", "details": {}}}` with status 400 (validation), 401, 403, 404, 409 (state conflict), 422 (business rule) or 500.
Method and path
Roles
Purpose
Used by
`POST /auth/login`
public
`{email, password}` returns `{access_token, expires_at}` (HS256 JWT, 8 hours)
Login page
`GET /me`
all
User, role, customer, delivery days, next delivery date and cut-off
Header
`POST /speech/transcribe`
buyer, approver
Multipart `audio` (WebM/Opus, Ogg/Opus, MP4/AAC or WAV; at most 30 s and 2 MB), optional `language` (`fi`, `en`). Returns `{transcript_id, text, language, confidence, duration_s, words: [{text, start, end, confidence}], flagged_terms: [{text, kind: "allergen" / "diet", value}]}`. 422 `no_speech` if nothing intelligible was heard; 503 `stt_unavailable` if the speech model is off
Chat (microphone)
`POST /chat`
buyer, approver
`{text, order_id?, input_mode?: "text" / "voice", transcript_id?}` returns a server-sent event stream (below). `transcript_id` links the sent text to its raw transcript for the audit log
Chat
`GET /products/search`
all
Query: `q`, `exclude_allergens`, `diets`, `group`, `deliverable_by`, `limit`
Search
`GET /products/{id}`
all
One product
Compare view
`GET /orders`
all
Query: `status`
Orders page
`GET /orders/{id}`
all
Order with lines
Workspace
`GET /orders/{id}/lines/{line_id}/comparison`
all
Recomputed options and exclusions for the line
Compare view
`POST /orders/{id}/lines`
buyer, approver
`{query or product_id, quantity?, unit?}` adds a line
Workspace
`PATCH /orders/{id}/lines/{line_id}`
buyer, approver
`{product_id?, packs?}`
Compare view (override)
`DELETE /orders/{id}/lines/{line_id}`
buyer, approver
Removes a line
Workspace
`POST /orders/{id}/confirm`
buyer, approver
Returns the order, now `confirmed` or `awaiting_approval`
Workspace
`POST /orders/{id}/send-back`
approver
`awaiting_approval` to `draft`
Orders page
`POST /orders/{id}/cancel`
buyer, approver
Orders page
`GET /proposals`
all
Query: `status`
Approval inbox
`GET /proposals/{id}`
all
Approval inbox
`POST /proposals/{id}/decision`
buyer, approver
`{decision: "approve" or "reject", option_id?, comment?}`
Approval inbox
`POST /proposals/{id}/revert`
buyer, approver
Undoes an automatic change
Notification
`GET /policy`
all
Policy, plus `suggestions` (H8: event type, streak)
Policy panel, inbox
`PUT /policy`
approver, admin
Full policy, validated against section 7.3
Policy panel
`GET /preferences`
all
List of preferred and banned products
Policy panel, Compare view
`PUT /preferences/{product_id}`
buyer, approver
`{kind: "preferred" or "banned" or null}` (null removes)
Compare view, Policy panel
`GET /audit`
all
Query: `order_id`, `proposal_id`, `limit`, `cursor`
Audit timeline
`POST /events`
admin
`{type, product_id?, supplier_id?, payload, dedupe_key}`. Returns the created proposals
Event panel
`GET /export/decisions.jsonl`
admin
Training data export (section 16)
Admin page
`GET /healthz`
public
Process is up
Operations
`GET /readyz`
public
Database reachable; model `ok`, `degraded` (fallback in use) or `disabled`; speech `ok` or `disabled`
Header status dot, microphone button
Chat stream events. Each is `event: <type>` followed by a JSON `data` line.
Type
Data
`step`
`{agent, status: "started" / "done" / "failed", summary, used_fallback?}`
`clarification`
`{question, choices?}`
`order`
The full order after a change
`message`
`{text}` assistant text
`error`
Same shape as API errors
`done`
`{}`
11. Scoring
Only eligible candidates are scored (section 6.2). For a need of quantity `q`:
`packs = ceil(q / pack_size)`
`cost = packs × contract_price`
`supplied = packs × pack_size`
Criterion
Score (0 to 1, higher is better)
Default weight
Price
lowest cost among candidates ÷ this cost
0.40
Pack fit
`q ÷ supplied`
0.15
Familiarity
1 if the customer had this product in a confirmed order in the last 8 weeks, or has marked it preferred, else 0
0.15
Reliability
supplier reliability
0.10
Origin
1 if the origin is FI, else 0
0.10
CO2
lowest `co2_kg_per_unit` among candidates ÷ this one
0.10
The total score is the weighted sum, shown to 3 decimals. Ties are broken by lower cost, then by product id.
Worked example 1: cooking cream, 5 l, lactose-free
P-DAI-004 is excluded: not lactose-free.
Packs
Cost
Price
Fit
Familiar
Reliab.
Origin
CO2
Total
P-DAI-001 (1 l)
5
€16.00
0.891
1.000
1
0.97
1
1.000
0.953
P-DAI-002 (2 l)
3
€17.70
0.805
0.833
0
0.97
1
1.000
0.744
P-DAI-003 (1 l)
5
€14.25
1.000
1.000
0
0.90
0
0.853
0.725
P-DAI-001: 0.40 × 0.891 + 0.15 × 1 + 0.15 × 1 + 0.10 × 0.97 + 0.10 × 1 + 0.10 × 1 = 0.953.
The recommendation is P-DAI-001. It costs €1.75 more than the cheapest option, but it is the one the kitchen already uses and it is domestic.
Worked example 2: substitute for salmon fillet, 8 kg
Original line: P-FISH-001, 4 packs, €119.20.
Packs
Cost
Price
Fit
Familiar
Reliab.
Origin
CO2
Total
P-FISH-002 trout
4
€133.60
0.808
1.000
0
0.95
1
1.000
0.768
P-FZF-001 frozen cubes
8
€108.00
1.000
1.000
0
0.92
0
0.833
0.725
Guard on the recommended option, P-FISH-002, with the default policy:
Rule
Value
Limit
Result
Kill switch
on
pass
Event type allows automation
`stock_out` on
pass
Price increase
+12.1 %
5.0 %
fail
Line value
€133.60
€100.00
fail
Same product group
`fish_fresh`
`fish_fresh`
pass
No added allergens
none added
pass
Order total within limit
under €500
€500.00
pass
Verdict: `needs_approval`.
Worked example 3: substitute for fish fond, 1 l
Original line: P-STK-001, 1 pack, €9.80. P-STK-003 adds crustaceans and celery, so it goes to the "adds allergens" list and is not ranked. P-STK-002 is the only ranked option: €10.15, +3.6 %, same group, no added allergens, line value under €100, and automation is on for stock-outs. Verdict: `auto_apply`.
With `auto_enabled_by_event.stock_out = false`, the same event gives `needs_approval`, with only the "event type" rule failing.
12. Language model usage
12.1 Two tasks only
Task
Input
Output
If it fails
Parse
The user's text, today's date, the list of recipe names
`PurchaseRequest` JSON
Fallback parser
Explain
A list of computed facts about a comparison or proposal
One or two sentences
Template text
The model never sees or decides prices, allergens, eligibility, ranking or policy verdicts. It has no tools.
Speech recognition (section 12.6) is a separate model with a single job, turning audio into text. Its output reaches the language model only as reviewed user text, through the parse task above.
12.2 `PurchaseRequest`
```json
{
"intent": "order | search | help",
"delivery_date": "YYYY-MM-DD or null",
"reorder": false,
"dish": {"name": "string", "portions": 80},
"items": [{"query": "string", "quantity": 5, "unit": "kg | l | pcs | null"}],
"exclude_allergens": ["milk"],
"diets": ["lactose_free"]
}
```
`dish` may be null, and `items` may be empty. An `order` intent needs at least one of `reorder`, `dish` or `items`. Validation rules: allergens and diets must be values from section 9.3; portions must be 1 to 5000; quantities must be above 0; at most 40 items; the text input is at most 1000 characters.
12.3 Safeguards
Requests use JSON-schema-constrained output where the server supports it. The reply is validated either way.
The keyword detector always runs on the original text. The final limits are the union of the model's limits and the detector's. The model can add a limit, but it cannot remove one the user wrote.
`reorder` is true if either the model or the fallback keywords say so.
The explanation is checked: every number in the model's sentence must be one of the numbers in the facts it was given. If any number is not, the template text is used.
User text goes only into the parse prompt, and the result is only ever read as data. Product descriptions from suppliers are not put into prompts.
Timeouts are 12 seconds for parse and 6 seconds for explain. The template explanation is shown at once and is replaced if the model's version arrives in time.
12.4 Fallback parser
Pure Python, no model. Handles English and basic Finnish.
Date: ISO date, `dd.mm.`, today, tomorrow, and weekday names (`friday`, `perjantai`, `pe`).
Portions: a number followed by `portions`, `people`, `pax`, `annosta` or `hengelle`, or "for N".
Dish: recipe names and aliases found in the text.
Reorder: "the usual", "same as last", "usual order", "tavalliset", "normaali tilaus", "sama kuin viimeksi".
Items: the text is split on commas, "and", "ja" and new lines, then matched against the pattern "number, unit, name" with units kg, g, l, dl, pcs and kpl.
Limits: a keyword table. For example, "lactose-free" and "laktoositon" map to diet `lactose_free`; "no nuts" and "pähkinätön" map to allergen `nuts`; "gluten-free" and "gluteeniton" map to diet `gluten_free`.
12.5 Model and serving
The backend talks to any OpenAI-compatible chat completions endpoint. Settings: `LLM_ENABLED`, `LLM_BASE_URL`, `LLM_MODEL`, `LLM_TIMEOUT_PARSE_S`, `LLM_TIMEOUT_EXPLAIN_S`.
The default for local development is Qwen2.5-1.5B-Instruct (GGUF, 4-bit, about 1.1 GB), served by `llama-cpp-python` on CPU. If that package does not install on Python 3.13, the prebuilt `llama-server` from llama.cpp is used. The backend works with either.
Licence: to be confirmed on the model card before download. The working assumption is that the 1.5B model is Apache-2.0 and the 3B model is research-only, which is why the 1.5B is the default.
With `LLM_ENABLED=0`, the whole product works on the fallback paths.
12.6 Speech recognition
Job. Turn a short push-to-talk recording into text for the chat box. It does nothing else: no intent detection, no commands, no actions.
Model and serving (product)
`faster-whisper` (CTranslate2) in the backend process, on CPU with int8 weights. Default model: Whisper `small` (multilingual, about 250 MB at int8), which handles Finnish and English. `medium` can be configured where the hardware allows. Whisper weights are MIT-licensed; to be confirmed on the model card before download.
Settings: `STT_ENABLED`, `STT_MODEL` (default `small`), `STT_DEVICE` (default `cpu`), `STT_COMPUTE_TYPE` (default `int8`), `STT_LANGUAGES` (default `fi,en`), `STT_TIMEOUT_S` (default 15), `STT_MAX_SECONDS` (default 30).
The model loads once at startup. If loading fails, `/readyz` reports speech `disabled` and the microphone button is disabled. Nothing else is affected.
Decoding: beam size 5, voice-activity filter on, language detection limited to `STT_LANGUAGES`. Audio is decoded in memory and never written to disk.
Domain vocabulary. The decoder gets an initial prompt built from the seed data: recipe names and aliases, synonym terms, and the allergen and diet keywords from section 12.4, in Finnish and English. This makes words like "lohikeitto", "ruokakerma" or "laktoositon" much more likely to come out right. The prompt is built from catalogue data only, never from earlier user audio.
Confidence. Each word carries the model's probability. Words below 0.6 are returned with that score and underlined in the chat box. The recording's average is stored in the audit log. Confidence never blocks sending; it only draws the person's eye.
Flagged terms. After transcription, the keyword detector (section 12.4) runs on the transcript, and every allergen or diet term it finds is returned in `flagged_terms` so the UI can highlight it. This is the same detector that runs again on the sent text in Intake.
Numbers. Spoken numbers come out as digits or words depending on the model ("80" or "eighty", "kahdeksankymmentä"). The fallback parser (section 12.4) is extended to read number words from 1 to 1000 in English and Finnish, including Finnish case endings ("kahdeksallekymmenelle"), so a spoken request parses without the model.
Safety rules
The transcript is shown and editable before it is sent (F8, hard rule 7). There is no auto-send.
The speech path has no access to orders, proposals or the policy. It cannot call `/chat` itself; the browser sends the reviewed text.
If transcription times out or fails, the reply is "Speech recognition failed. Please try again or type your order." Nothing is retried in the background.
13. UI specification
One React app. Components get data only through the `AgentClient` interface.
Header (all pages): product name, customer name, next delivery date with a cut-off countdown, approval inbox badge with the pending count, model status dot and user menu. In the demo build it also has a role switch (buyer / approver) and the banner "Demo mode: scripted agent, synthetic data. No real orders are placed."
Footer: "Synthetic catalogue. Not Valio Aimo product or price data."
Screen
Content
States
Login (product only)
Email, password
Wrong credentials; server unreachable
Workspace
Left: chat, with the agent's steps shown as a short list that ticks off as each completes, and a "fallback used" tag when relevant. Next to the chat box, a microphone button (F8) with a recording level meter and elapsed time. The transcript lands in the chat box with unsure words underlined and allergen and diet terms highlighted; voice messages carry a small microphone icon in the chat history. Right: the current draft order with lines (product, packs, cost, flags, source label), total, constraints as chips and a Confirm button
Empty (three example requests to click, including "The usual for Friday", and the hint "or hold the microphone and speak"); recording; transcribing; transcript ready for review; nothing heard; microphone permission denied; speech unavailable (button disabled with reason); streaming; unmatched line; clarification question with choice buttons; over the order limit (the button reads "Send for approval")
Compare (drawer from a line)
Options table per section 11, score bars per criterion, explanation, "Filtered out" list, and "Choose", "Prefer" and "Ban" on each option
Only one option; no options
Approval inbox
Proposal cards: trigger, order and line, options, recommended option, guard rule results as pass/fail rows, time to cut-off, Approve / choose other / Reject with an optional comment. H8 suggestion banner at the top when there is one
Empty; expired; decision conflict
Notifications
Toast and list for automatic changes with Undo, and for recall notices
Undo no longer possible
Orders
List by status; detail with lines and the audit timeline
Empty
Policy
Form for section 7.3: the kill switch, one toggle per event type (recall shown locked), the three fixed rules shown locked, and weights as sliders that must sum to 100 %. A "Preferred and banned products" list with remove buttons
Validation errors; read-only for buyers (except preferences)
Audit timeline
Entries in time order with an actor icon (agent, person, system), the action and expandable data
Empty
Search
Query box, filters, result table, "add to draft"
No results; banned product (add disabled)
Event panel (admin; presenter panel in the demo)
Buttons for the prepared events, form for a custom event
Accessibility: WCAG 2.1 AA. Everything is reachable by keyboard, focus is visible, form fields have labels, pass/fail is never shown by colour alone, and text contrast meets AA. Voice is always optional: every voice action has a typed equivalent. The microphone button works by keyboard (`Space` to hold, or tap mode), its recording state is announced to screen readers, and highlights in the transcript use underline and weight, not colour alone. The microphone button is at least 48 × 48 px for use with gloves or wet hands.
14. Demo specification
The demo build uses `demoClient`, which implements `AgentClient` in the browser over the seed JSON. Finder, Comparator and Guard are implemented in TypeScript with the same rules, and checked against golden test vectors shared with the Python tests (section 17). Intake is scripted for the scene texts and uses a small keyword parser for anything else. Agent steps appear with fixed delays of 400 to 900 ms.
Voice in the demo. `demoClient.transcribe(audio)` runs Whisper `base` (quantised, about 80 MB) in the browser through Transformers.js in a web worker. The model files are bundled with the static build, so voice works with the network disabled. The browser's built-in Web Speech API is not used, because some browsers send the audio to a cloud service. The same initial prompt and keyword highlighting as the product are applied. The transcript then follows the normal path: review in the chat box, Send, scripted Intake. If the model is not loaded or the room is too loud, the presenter types the same sentence; the scenes do not depend on voice.
Demo clock: fixed at Tuesday 17 November 2026, 09:12 Helsinki time. Friday's delivery has its cut-off on Thursday 19 November at 14:00.
State: kept in memory and mirrored to `localStorage`, so an accidental refresh does not lose the scene. Reset clears it.
Presenter keys: `1` fish fond stock-out, `2` salmon stock-out, `3` recall of P-DAI-003 batch L2611, `Shift+R` reset, `?` show this list.
Scene 1: Find (about 40 seconds)
Hold the microphone and say "Salmon soup for 80 on Friday, lactose-free" (or click the example, or type it). With voice, point at the transcript in the chat box with "lactose-free" highlighted, then press Send.
The steps tick off: Read request, Match recipe, Find products (8 ingredients), Compare options, Build draft.
The draft appears with 8 lines, the chip "lactose-free", delivery "Fri 20 Nov", and a total under the €500 limit.
Say: nothing has been ordered. This is a draft. And the chef's voice never left the building.
Optional, if time allows (about 15 seconds, not in the 3-minute pitch): in a fresh draft, click "The usual for Friday". The history lines appear tagged "from history". This shows F6 without touching the numbers of the main scenes.
Scene 2: Compare (about 40 seconds)
Open the cooking cream line. The table matches worked example 1. "Filtered out" shows P-DAI-004: not lactose-free.
Point at the reason: the recommended option is €1.75 more than the cheapest, but it is already used by the kitchen and it is domestic.
Choose P-DAI-003 instead, to save €1.75. The line updates and is tagged "your choice". Leave it that way; the optional recall at the end of scene 3 then has something to act on.
Click Confirm. The status becomes `confirmed`.
Scene 3: Surprise (about 60 seconds)
Press `1`. A toast appears: "Fish fond is out of stock for Friday. Replaced with Fish fond concentrate, +€0.35 (+3.6 %). Within your limits. Undo". This matches worked example 3.
Press `2`. The inbox badge shows 1. Open it: salmon fillet is out of stock until Monday 23 November. The options match worked example 2, plus "wait until Tue 24 Nov" and "remove line". The guard rows show two fails: price +12.1 % over 5 %, and line value over €100.
Switch role to approver if desired, and approve the trout. The order total updates.
Open the audit timeline for the order: request, agent steps, human confirm, event, automatic change, event, proposal, human approval.
Optional: press `3` to recall the imported cream chosen in scene 2. The product is blocked at once, and a proposal offers P-DAI-001 instead (€16.00, +12.3 %). A recall always waits for a person, whatever the other guard rules say.
Pitch outline (3 minutes)
Problem, 20 seconds: ordering is manual, and shortages are found when the truck arrives.
Scenes 1 to 3, about 2 minutes 20 seconds.
How it works, 20 seconds: a buyer side and a seller side exchange structured proposals. A small model on your own hardware reads and writes; code decides; people approve. Every decision becomes training data.
15. Non-functional requirements
Security
Passwords are hashed with Argon2id. The JWT secret comes from the environment, and the app refuses to start in production mode with the default secret.
Role checks on every route; every query is filtered by the token's customer.
Limits on request size and text length. CORS is limited to configured origins.
No secrets in the repository. `.env.example` lists the settings.
Privacy
No user text, audio or order data leaves the machine where the backend and the models run. There are no calls to outside services at run time.
Audio is held in memory only for the length of the transcription request, then discarded. It is never written to disk, logged or exported. Only the transcript is kept. The browser asks for microphone permission only when the button is first pressed, and the microphone is released as soon as recording stops.
Designed for GDPR: customer data is separated by `customer_id`, and a customer never sees another customer's data.
The decision export is admin-only and replaces user ids with stable pseudonyms.
Performance targets (targets on the 12-core CPU development machine, not yet measured)
Catalogue search under 100 ms. Comparison for one line under 50 ms.
A dish or reorder request end to end in under 10 seconds with the model, and under 1 second on the fallback.
An event is turned into proposals in under 1 second.
A 10-second recording is transcribed in under 4 seconds with Whisper `small` on the backend, and under 6 seconds with Whisper `base` in the demo browser.
Reliability
The product is fully usable with the language model down, and with the speech model down (typing still works).
Event processing, decisions and order confirmation are idempotent.
SQLite in WAL mode for the pitch and single-site use. Access goes through SQLAlchemy, so a move to PostgreSQL does not touch agent code.
Operations
Structured JSON logs with a request id. `/healthz` and `/readyz`.
Configuration only through environment variables.
Dockerfiles are provided. They cannot be tested on the development machine, which has no Docker.
Languages: English UI. Dates are shown as "Fri 20 Nov" and money as "€16.00".
16. Fine-tuning path (prepared, not run)
What is logged
Parse examples: the user's text, the model's or fallback's `PurchaseRequest`, and the final state of the draft after the person's edits.
Choice examples: for each comparison or proposal, the options with their criteria, the recommended option and the option the person chose.
Preference changes, as signals for the comparator weights.
Transcript corrections: the raw voice transcript and the text the person actually sent, when they differ. Text only; audio is never kept. These pairs show which words the speech model gets wrong and feed the domain vocabulary prompt (section 12.6) first, and a speech fine-tune later.
Export: `GET /api/export/decisions.jsonl`, one JSON object per line in chat format: `{"task": "parse", "messages": [{"role": "system", ...}, {"role": "user", ...}, {"role": "assistant", ...}]}`.
Later steps
Use overrides and preferences to adjust the comparator weights per customer. This needs no model training and is the first thing to try.
Fine-tune the parse task with LoRA on the base model, on a machine with a GPU (`training/finetune_lora.py`).
Release a tuned model only if it beats the base model on a held-out set and its recall on allergen and diet limits is no lower.
17. Test plan and definition of done
Backend (pytest), all passing with `LLM_ENABLED=0`. Guard rules and Finder exclusion rules have 100 % branch coverage.
Test
Stories
Recipe scaling gives the quantities in section 9.5 for 80 portions
F1
Item list parsing; a missing quantity sets `quantity_assumed`
F2
Property test over the whole catalogue: no result ever contains an excluded allergen or lacks a required diet flag
F3
A product with unknown allergens is excluded with "allergen data missing" when any limit applies, and is never a ranked substitute
F3, 6.4
Model output that drops a limit still ends with the limit applied
F3
No match gives an unmatched line with a reason
F4
Search finds products by Finnish name, English name and synonym
F5
"The usual for Friday" on the seed history gives the expected lines and packs (golden vector); fewer than 3 same-weekday orders falls back to all days; an empty history gives the "no order history" reply
F6
A blocked or banned history product becomes an unmatched line with the reason, and is never silently swapped
F6, F7
"The usual plus salmon soup for 80" gives both sets of lines, labelled by source
F6
A banned product is excluded with "banned by customer"; a preferred product gets familiarity 1; the worked examples are unchanged with no preferences
F7, C5
Worked examples 1, 2 and 3 reproduce to 3 decimals
C1, C2, S1, S5
Exclusion reasons are listed
C3
An override sets `human_override` and writes the audit entry
C4
Each event type creates the expected proposals; the same event twice creates nothing new
S1-S4
Guard boundaries: 4.9 % and 5.0 % pass, 5.1 % fails; line value at and over the limit
S5
Event-type toggle off turns worked example 3 into `needs_approval`; kill switch off does the same for every type
S5, H6
A recall never auto-applies, even when all other rules pass; the product is blocked
S4, H6
Nothing under `agents/` can set an order to `confirmed`: the status change exists only in the orders service and requires a user id, and a test scans the agent modules for any call to it
H1
An order over the limit goes to `awaiting_approval`; the buyer cannot confirm it
H2
Decision idempotency and conflict
H4
Revert restores the line; revert is refused after the cut-off
H5
Policy validation; the fixed rules and the recall toggle cannot be changed
H6
Audit entries exist for each action, including preference changes, and cannot be altered through the API
H7
The trust suggestion appears after 5 unchanged approvals in a row while a type is off, resets on a reject or a different option, and never changes the policy by itself
H8
A fake model returning invalid JSON, a timeout, or wrong numbers in an explanation each triggers the fallback
12.3
Disagreement between model and fallback on dish, date or portions gives a clarification
6.1
Speech, with a fake transcriber: the transcribe route returns text, language, word confidences and flagged allergen and diet terms; silence gives 422 `no_speech`; over 30 s or 2 MB gives 400; `STT_ENABLED=0` gives 503 and `/readyz` reports speech `disabled`
F8, 12.6
Speech, with the real model on a set of recorded and synthetic clips (`tests/audio/`, Finnish and English, including the scene 1 sentence): the transcript parses to the expected `PurchaseRequest` with the fallback parser; every allergen and diet term spoken is in `flagged_terms`
F8, 12.6
A voice request creates nothing until `/chat` is called with the reviewed text; `/chat` with `input_mode: voice` gives the same draft as the same text typed; the order stores `input_mode` and the audit log holds the raw and sent text
F8, 7.1
No audio is written to disk or the database during transcription (temporary directory and database checked after a run)
15
The fallback parser reads English and Finnish number words, including "kahdeksallekymmenelle" as 80
12.6
Role and customer isolation on every route
15
Frontend
Type-check with no errors.
The demo engine reproduces the golden vectors in `data/seed/golden_vectors.json`: the three worked examples first, then the F6 reorder vector, then more vectors added from the Python implementation.
A unit test runs the three scenes and a reset against `demoClient` from a script.
A unit test of the microphone flow with a mocked recorder and transcriber: the transcript lands in the chat box, is not sent until Send is pressed, and highlights flagged terms; permission denied and speech unavailable disable the button with a reason.
Manual
Demo build served as static files with the network disabled: play all scenes twice, with a reset in between. Do scene 1 once by voice and once typed.
Product: the same three scenes through the real API, first with the model on, then with it off. Scene 1 by voice in Finnish and in English, with kitchen-like background noise.
Definition of done for the pitch: the demo build passes the manual check, the backend tests pass, and the product runs the three scenes with the model off. The model-on run and voice in the product build are goals, not blockers. Voice in the demo build is part of done, because it is shown in scene 1, but the scenes must also pass typed.
18. Known limits, risks and open questions
Limits
All data is synthetic. Nothing is connected to Valio Aimo systems.
One customer in the seed data. One language in the UI.
"Production ready" here means a tested core with login, roles, audit and fallbacks. It has not been load-tested or security-audited.
The scoring logic exists twice (Python and TypeScript). The golden vectors keep the two in step, but they do not make drift impossible.
The buyer and seller sides run in one process and are separated only in code. A real two-party deployment would need the proposal format as a network protocol.
Risks
Risk
Response
A wrong substitution (allergen or diet)
Deterministic Finder and Guard outside the model; unknown data counts as non-compliant; property test over the whole catalogue
Speech is misheard, especially an allergen or negation ("no nuts" heard as "nuts")
The transcript is always reviewed before sending; allergen and diet terms are highlighted and unsure words underlined; the keyword detector and hard filters run on the sent text as for typed text; voice can never confirm an order
Finnish recognition is weak with a small model, or the kitchen is loud
Domain vocabulary prompt; `medium` model configurable; push-to-talk keeps clips short; typing always works; corrections are logged for later tuning
The in-browser speech model is too large or slow for the demo laptop
Bundle Whisper `base`, preload it in a worker at page load, and type the sentence if it is not ready
The model makes up prices or stock
The model never sees them; the explanation number check falls back to template text
Over-automation erodes trust
Automation per event type, a kill switch, undo, and trust suggestions that never act on their own
Product data quality (allergens, units, translations)
Unknown allergen data excludes the product; unit mismatch excludes the product
The local model does not install or is too slow on CPU
The fallback paths carry the product; the demo needs no model
48 hours is not enough for the whole production core
The build order puts the demo first. Cut from the end: Dockerfiles, export endpoint, voice in the product build (keep it in the demo), H8 trust suggestion, search page, delivery-delay events
A judge asks about real data
Point to the provider interfaces and the earlier research on Valio's SAP Commerce storefronts; say plainly that it is not connected
Real integration effort is underestimated
The provider interfaces are defined from day one, with contract tests against the SQLite implementation
Assumptions
Real product data includes structured allergen, unit and pack information.
Customers have contract prices and a delivery calendar with cut-offs.
The baselines in section 2.3 roughly hold.
Open questions
Should the seed data use real Valio product names for recognition? This spec says no, to avoid showing invented prices next to real brands.
What are the exact pitch time and length, and will the demo be shown from a laptop or does it need a hosted URL?
Are the judging criteria published? If so, they should be mapped to section 1.3.
Should the fallback parser handle Finnish more fully than the basic keywords listed?
Is there access to real or sample Valio Aimo APIs, and on what timeline? (This decides Release 2.)
Should the seller side later make proactive offers (for example, a cheaper equivalent before any disruption), or only fix problems?
Is Whisper `small` good enough for Finnish kitchen speech, or is a Finnish-tuned Whisper model needed? This needs a quick test with real recordings before the pitch.
Will the pitch room allow speaking to the laptop (microphone quality, noise)? If not, scene 1 is typed and voice is mentioned only.
Should Swedish speech be recognised in this release, given that the UI is English only?
