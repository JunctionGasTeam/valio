// Policy engine: hard rules (context.md §8.1) + customer policy (§8.2) → verdict. Any failed rule → a human signs off.
import { z } from '@hono/zod-openapi';
import type { DatabaseSync } from 'node:sqlite';
import { getProduct, ineligibility, type Limits } from './catalogue.ts';
import type { Part } from './planner.ts';
import { quantityInText } from './parse.ts';

export const PolicySchema = z.object({
  agent_may_finalise: z.boolean().default(false),
  max_order_eur: z.number().min(0).default(500),
  max_line_eur: z.number().min(0).default(200),
  allow_split: z.boolean().default(true),
  allow_unconfirmed_stock: z.boolean().default(false),
  max_over_best_price_pct: z.number().min(0).default(10),
}).openapi('Policy');
export type Policy = z.infer<typeof PolicySchema>;

/** Agent key limits can only tighten the customer policy, never loosen it (§8.2). */
export function effectivePolicy(customer: Policy, limits: Partial<Policy> | null): Policy {
  const out: Record<string, unknown> = { ...customer };
  for (const [k, v] of Object.entries(limits ?? {})) {
    const cur = out[k];
    if (typeof v === 'boolean' && typeof cur === 'boolean') out[k] = cur && v;
    if (typeof v === 'number' && typeof cur === 'number') out[k] = Math.min(cur, v);
  }
  return out as Policy;
}

export type PlannedItem = {
  item: { need: string; quantity: number; unit: string }; category?: string | null;
  allocation: Part[]; shortfall: number; errors: string[]; options: { unit_price_cents: number; available?: number | null; late?: boolean }[];
};
export type Rule = { rule: string; hard: boolean; ok: boolean; detail: string };
export type Verdict = { rules: Rule[]; requires_human: boolean; total_cents: number | null };

// ponytail: name heuristic, the dataset has no alcohol categories (only 0 % drinks, alcohol ice cream, disinfectants).
// A false positive only adds a human check. Replace with Valio's licence categories in production.
const ALCOHOL = /alkoholi(?!ton|holiton)/i;
const eur = (c: number) => `€${(c / 100).toFixed(2)}`;

// A quantity this many times above or below the usual one needs a human: 1000 typed for 100 is plausible text.
// MIN_HISTORY approved orders in a category also make it routine: the only orders an agent may finish alone.
const UNUSUAL = 3, MIN_HISTORY = 3;
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2; };

/** `history`: quantities this customer approved before, keyed `category|unit` (see historyKey). */
export const historyKey = (it: Pick<PlannedItem, 'category' | 'item'>) => `${it.category}|${it.item.unit}`;

export function evaluate(
  db: DatabaseSync, items: PlannedItem[],
  limits: Limits & { budget_eur?: number | null; source_text?: string; from_agent?: boolean }, policy: Policy,
  history: Map<string, number[]> = new Map(),
): Verdict {
  try {
    const rules: Rule[] = [];
    const add = (rule: string, hard: boolean, ok: boolean, pass: string, fail: string) =>
      rules.push({ rule, hard, ok, detail: ok ? pass : fail });
    const lines = items.flatMap((it) => it.allocation.map((a) => ({ it, a })));
    const total = lines.reduce((s, l) => s + l.a.cost_cents, 0);
    const ids = (xs: { a: Part }[]) => xs.map((x) => x.a.id).join(', ');

    // Hard rules: no setting changes them.
    const breaking = lines.filter(({ a }) => { const p = getProduct(db, a.id); return !p || ineligibility(p, limits).length > 0; });
    add('allergen_and_diet_limits', true, !breaking.length, 'every line meets the allergen and diet limits', `lines break the limits: ${ids(breaking)}`);
    const alcohol = lines.filter(({ a }) => ALCOHOL.test(a.name));
    add('alcohol_needs_human', true, !alcohol.length, 'no alcohol lines', `alcohol lines always need a human: ${ids(alcohol)}`);
    const short = items.filter((it) => it.shortfall > 1e-9);
    add('need_covered', true, !short.length, 'every item fully covered',
      short.map((it) => `${it.item.need}: ${+it.shortfall.toFixed(3)} of ${it.item.quantity} ${it.item.unit} not covered`).join('; '));
    const late = lines.filter(({ a }) => a.flags.includes('E3'));
    add('on_time', true, !late.length, 'every line arrives by the requested date', `late lines go to a later delivery: ${ids(late)}`);
    const cached = items.filter((it) => it.errors.length);
    add('live_prices', true, !cached.length, 'prices and availability fetched live', `API trouble, cached offers used: ${cached.flatMap((it) => it.errors).join('; ')}`);
    // Trust: the request must say what the person wrote, and look like what they usually order.
    if (limits.source_text) {
      const off = items.filter((it) => !quantityInText(limits.source_text!, it.item.quantity));
      add('matches_request_text', true, !off.length, 'every quantity appears in the original text',
        `not in the original text: ${off.map((it) => `${it.item.quantity} ${it.item.unit} ${it.item.need}`).join(', ')}`);
    } else if (limits.from_agent) {
      // An agent that leaves the person's words out cannot skip the check: nothing to compare against → a human looks.
      add('matches_request_text', true, false, '', 'not in the original text: the agent sent no original text (source_text) to check the quantities against');
    }
    const odd = items.flatMap((it) => {
      const past = history.get(historyKey(it)) ?? [];
      if (past.length < MIN_HISTORY) return [];
      const usual = median(past), x = it.item.quantity / usual;
      return x >= UNUSUAL || x <= 1 / UNUSUAL ? [`${it.item.need} ${it.item.quantity} ${it.item.unit}, usually ${+usual.toFixed(3)} ${it.item.unit} (${past.length} past orders)`] : [];
    });
    add('usual_quantity', true, !odd.length, 'quantities in line with past orders, or too few to compare', `unusual quantity, check for a typo: ${odd.join('; ')}`);
    if (limits.budget_eur != null)
      add('request_budget', true, total <= limits.budget_eur * 100, `${eur(total)} within budget €${limits.budget_eur}`, `${eur(total)} over budget €${limits.budget_eur}`);

    // Customer policy (the owner edits it, agent keys can only tighten it).
    add('agent_may_finalise', false, policy.agent_may_finalise, 'policy lets the agent finalise within limits', 'policy: every order needs a human sign-off');
    add('max_order_eur', false, total <= policy.max_order_eur * 100, `order ${eur(total)} ≤ €${policy.max_order_eur}`, `order ${eur(total)} > €${policy.max_order_eur}`);
    const big = lines.filter(({ a }) => a.cost_cents > policy.max_line_eur * 100);
    add('max_line_eur', false, !big.length, `every line ≤ €${policy.max_line_eur}`, `lines over €${policy.max_line_eur}: ${ids(big)}`);
    const split = items.filter((it) => it.allocation.length > 1);
    add('allow_split', false, policy.allow_split || !split.length, 'no split or splits allowed', `split items: ${split.map((it) => it.item.need).join(', ')}`);
    // Valio reports no amount (>= 999999: "unknown, any quantity may be ordered"). Off by default: a person looks.
    const unknown = lines.filter(({ a }) => a.flags.includes('E5'));
    add('confirmed_stock', false, policy.allow_unconfirmed_stock || !unknown.length,
      unknown.length ? 'policy accepts lines without a confirmed amount' : 'Valio confirms stock for every line', `stock not confirmed: ${ids(unknown)}`);
    // Reference: the cheapest option sure to arrive (an unconfirmed bargain is not a fair comparison).
    const reference = (it: PlannedItem) => {
      const sure = it.options.filter((o) => o.available !== null && o.available !== undefined && !o.late);
      return Math.min(...(sure.length ? sure : it.options).map((o) => o.unit_price_cents));
    };
    const pricey = lines.filter(({ it, a }) => a.unit_price_cents > reference(it) * (1 + policy.max_over_best_price_pct / 100) + 1e-9);
    add('max_over_best_price_pct', false, !pricey.length, `every line within ${policy.max_over_best_price_pct} % of the cheapest confirmed price per unit`,
      `more than ${policy.max_over_best_price_pct} % over the cheapest confirmed price per unit: ${ids(pricey)}`);
    // Autonomy covers routine orders only: products this customer has approved often enough.
    if (policy.agent_may_finalise) {
      const fresh = items.filter((it) => (history.get(historyKey(it))?.length ?? 0) < MIN_HISTORY);
      add('routine_order', false, !fresh.length, `every item ordered and approved at least ${MIN_HISTORY} times before`,
        `not routine yet (fewer than ${MIN_HISTORY} approved orders): ${fresh.map((it) => it.item.need).join(', ')}`);
    }

    return { rules, requires_human: rules.some((r) => !r.ok), total_cents: total };
  } catch (e) {
    // §8.1 rule 6: a policy engine error never lets anything through.
    return { rules: [{ rule: 'policy_engine', hard: true, ok: false, detail: `policy error (${(e as Error).message}); a human must review` }], requires_human: true, total_cents: null };
  }
}
