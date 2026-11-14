// Planner: one requested item → filtered, priced, scored options and an allocation (context.md §7, §9).
import type { DatabaseSync } from 'node:sqlite';
import { search, type Limits, type Product } from './catalogue.ts';
import { checkOffers, type Offer } from './offers.ts';

export type Unit = 'kg' | 'l' | 'pcs';
export type Item = { need: string; quantity: number; unit: Unit };

// price / availability / reliability / co2 / origin (§9.3)
export const PRESETS = {
  price_and_availability: { price: 0.4, availability: 0.25, reliability: 0.15, co2: 0.1, origin: 0.1 },
  sustainability: { price: 0.3, availability: 0.2, reliability: 0.1, co2: 0.3, origin: 0.1 },
  reliability_first: { price: 0.3, availability: 0.2, reliability: 0.35, co2: 0.05, origin: 0.1 },
};
export type Priorities = keyof typeof PRESETS;
type Criterion = keyof typeof PRESETS.price_and_availability;

const FINNISH_MARKS = ['GOODS_FROM_FINLAND_BLUE_SWAN', 'MADE_IN_FINLAND_FLAG_WITH_KEY', 'FINNISH_HEART_SYMBOL', 'PUHTAASTI_KOTIMAINEN'];
const DROP: Partial<Record<string, string>> = {
  E2: 'not deliverable (E2)', E6: 'order cut-off passed (E6)', E7: 'no price (E7)', E9: 'no API response and no cache (E9)',
};

export type Option = {
  id: string; name: string; product: Product; offer: Offer;
  content: number; content_flag: 'content_from_price' | 'content_mismatch' | null;
  lot: number; available: number | null; late: boolean;
  unit_price_cents: number; // per l / kg / sales unit
  units_alone: number;      // sales units to cover the whole need with this option
  criteria: Partial<Record<Criterion, number>>; score: number;
};
export type Part = {
  id: string; name: string; unit_price_cents: number; sales_units: number; sales_unit: string; covers: number;
  cost_cents: number; date: string | null; flags: string[]; reason: string;
};

const nameOf = (p: Product) => p.name_fi ?? p.name_en ?? p.id;
const eur = (c: number) => `€${(c / 100).toFixed(2)}`;
const step = (lot: number) => (lot < 1 ? 1 : lot); // organisers: 0.01 means 1 (§2.1)

/** Sales units covering `qty`, rounded up to the lot step. */
export function unitsFor(qty: number, content: number, lot: number) {
  const s = step(lot);
  return Math.ceil(qty / content / s - 1e-9) * s;
}

/** Content per sales unit in the requested unit (§7.2). null = cannot be matched. */
function contentOf(p: Product, o: Offer, unit: Unit): Pick<Option, 'content' | 'content_flag'> | null {
  if (unit === 'pcs') return { content: 1, content_flag: null };
  const data = unit === 'l' ? p.content_l : p.content_kg;
  const api = o.comparison_unit === (unit === 'l' ? 'L' : 'KG') && o.price_cents && o.comparison_cents
    ? o.price_cents / o.comparison_cents : null;
  if (data && api && Math.abs(data - api) / api > 0.03) return { content: api, content_flag: 'content_mismatch' };
  if (data) return { content: data, content_flag: null };
  if (api) return { content: api, content_flag: 'content_from_price' };
  return null;
}

/** Fill from the best on-time option, split up to 3 products, late (E3) options last (§7.2). */
export function allocate<T extends Pick<Option, 'content' | 'lot' | 'available' | 'late'>>(qty: number, ranked: T[]) {
  let remaining = qty;
  const parts: { option: T; units: number; covers: number }[] = [];
  for (const o of [...ranked.filter((o) => !o.late), ...ranked.filter((o) => o.late)]) {
    if (remaining <= 1e-9 || parts.length === 3) break;
    let units = unitsFor(remaining, o.content, o.lot);
    if (o.available !== null) units = Math.min(units, Math.floor(o.available / step(o.lot)) * step(o.lot));
    if (units <= 0) continue;
    const covers = Math.min(remaining, units * o.content);
    remaining -= covers;
    parts.push({ option: o, units, covers });
  }
  return { parts, shortfall: Math.max(0, remaining) };
}

/** Human/agent overrides from revise_proposal: only confirmed amounts (demo scene 4), or one chosen option. */
export type Overrides = { confirmed_only?: boolean; choose?: string };

export async function planItem(
  db: DatabaseSync, item: Item, limits: Limits, deliverBy: string,
  priorities: Priorities = 'price_and_availability', overrides: Overrides = {},
) {
  const exceptions = new Set<string>();
  const { category, matches, excluded } = search(db, item.need, limits);
  if (excluded.some((e) => e.reasons.includes('allergen data missing'))) exceptions.add('E8');
  const result = {
    item, category, overrides, exceptions: [] as string[], errors: [] as string[],
    excluded: excluded.map((e) => ({ id: e.product.id, name: nameOf(e.product), reasons: e.reasons })),
    dropped: [] as { id: string; name: string; reasons: string[]; substitutes: string[] }[],
    options: [] as Option[], allocation: [] as Part[], shortfall: item.quantity,
  };
  if (!matches.length) return { ...result, exceptions: ['E1', ...exceptions].sort() };

  const { offers, errors } = await checkOffers(db, matches.map((p) => p.id), deliverBy);
  result.errors = errors;
  const droppedProducts: Product[] = [];
  for (const [i, product] of matches.entries()) {
    const offer = offers[i];
    const reasons = offer.exceptions.flatMap((e) => DROP[e] ?? []);
    const c = contentOf(product, offer, item.unit);
    if (!reasons.length && !c) reasons.push(`unit cannot be matched (${item.unit})`);
    if (reasons.length || !c) {
      offer.exceptions.forEach((e) => DROP[e] && exceptions.add(e));
      result.dropped.push({ id: product.id, name: nameOf(product), reasons, substitutes: [] });
      droppedProducts.push(product);
      continue;
    }
    result.options.push({
      id: product.id, name: nameOf(product), product, offer, ...c,
      lot: product.lot_size, available: offer.available_amount, late: offer.exceptions.includes('E3'),
      unit_price_cents: offer.price_cents! / c.content,
      units_alone: unitsFor(item.quantity, c.content, product.lot_size),
      criteria: {}, score: 0,
    });
  }

  score(db, result.options, priorities, limits.labels_required ?? []);
  const rank = new Map(result.options.map((o, i) => [o.id, i]));

  // E2: substitutes from the pairs, then same category; never one that adds an allergen (§8.1 rule 3).
  const subsOf = db.prepare('SELECT substitute FROM substitutions WHERE product = ?');
  for (const [i, d] of result.dropped.entries()) {
    const orig = droppedProducts[i];
    const allergens = new Set([...orig.contains, ...orig.may_contain]);
    const safe = (o: Option) => [...o.product.contains, ...o.product.may_contain].every((a) => allergens.has(a));
    const pairs = subsOf.all(d.id).map((r: any) => r.substitute as string).filter((s) => rank.has(s));
    const cands = pairs.length ? pairs.map((s) => result.options[rank.get(s)!]) : result.options.filter((o) => o.product.category === orig.category);
    d.substitutes = cands.filter(safe).slice(0, 3).map((o) => o.id);
  }

  const pool = overrides.choose ? result.options.filter((o) => o.id === overrides.choose)
    : overrides.confirmed_only ? result.options.filter((o) => o.available !== null) : result.options;
  const { parts, shortfall } = allocate(item.quantity, pool);
  result.shortfall = shortfall;
  const best = result.options.length ? Math.min(...result.options.map((o) => o.unit_price_cents)) : 0;
  const u = item.unit === 'pcs' ? 'unit' : item.unit;
  result.allocation = parts.map(({ option: o, units, covers }, i) => {
    const flags = [
      ...(o.available === null ? ['E5'] : []), ...(o.late ? ['E3'] : []),
      ...(parts.length > 1 || shortfall > 0 ? ['E4'] : []), ...(o.content_flag ? [o.content_flag] : []),
    ];
    flags.forEach((f) => f.startsWith('E') && exceptions.add(f));
    const facts = [
      `rank ${rank.get(o.id)! + 1} of ${result.options.length} deliverable, score ${o.score.toFixed(2)}`,
      `${eur(o.unit_price_cents)}/${u} (best ${eur(best)}/${u})`,
      o.available === null ? 'amount not confirmed' : `${o.available} ${o.offer.sales_unit} available`,
      `delivers ${o.offer.available_date}`,
      ...(overrides.choose ? ['chosen by user'] : overrides.confirmed_only ? ['confirmed amounts only'] : []),
      ...(parts.length > 1 ? [`part ${i + 1} of ${parts.length}, covers ${+covers.toFixed(3)} of ${item.quantity} ${u}`] : []),
    ];
    return {
      id: o.id, name: o.name, unit_price_cents: o.unit_price_cents, sales_units: units, sales_unit: o.offer.sales_unit ?? o.product.sales_unit, covers,
      cost_cents: Math.round(units * o.offer.price_cents!), date: o.offer.available_date, flags, reason: facts.join('; '),
    };
  });
  result.exceptions = [...exceptions].sort();
  return result;
}

/** §9: criteria 0..1, weighted, missing CO2 skipped with weights rescaled; ties → lower cost, then id. Sorts in place. */
function score(db: DatabaseSync, opts: Option[], priorities: Priorities, labels: string[]) {
  if (!opts.length) return;
  const w = PRESETS[priorities];
  const vendorMean = new Map(
    db.prepare('SELECT vendor, avg(reliability) r FROM products WHERE reliability IS NOT NULL GROUP BY vendor').all()
      .map((r: any) => [r.vendor, r.r as number]),
  );
  const minPrice = Math.min(...opts.map((o) => o.unit_price_cents));
  const co2s = opts.flatMap((o) => (o.product.co2_per_kg ? [o.product.co2_per_kg] : []));
  const minCo2 = co2s.length ? Math.min(...co2s) : null;
  for (const o of opts) {
    const p = o.product;
    const c: Partial<Record<Criterion, number>> = {
      price: minPrice / o.unit_price_cents,
      availability: o.late ? 0 : o.available === null ? 0.7 : o.available >= o.units_alone ? 1 : 0.4,
      reliability: p.reliability ?? vendorMean.get(p.vendor) ?? 0.9,
      origin: Math.min(1, (p.origin === 'fi' || p.labels.some((l) => FINNISH_MARKS.includes(l)) ? 1 : 0)
        + 0.5 * labels.filter((l) => p.labels.includes(l)).length),
    };
    if (p.co2_per_kg && minCo2) c.co2 = minCo2 / p.co2_per_kg;
    const keys = Object.keys(c) as Criterion[];
    o.criteria = c;
    o.score = keys.reduce((s, k) => s + w[k] * c[k]!, 0) / keys.reduce((s, k) => s + w[k], 0);
  }
  const cost = (o: Option) => o.units_alone * o.offer.price_cents!;
  opts.sort((a, b) => b.score - a.score || cost(a) - cost(b) || a.id.localeCompare(b.id));
}
