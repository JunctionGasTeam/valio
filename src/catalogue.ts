// Local product search + eligibility rules (context.md §5 search_products, §7.1). No API calls here.
import type { DatabaseSync } from 'node:sqlite';

export type Diet = 'lactose_free' | 'gluten_free' | 'vegan' | 'vegetarian';
export type Limits = {
  exclude_allergens?: string[]; // GS1 codes, e.g. AM (milk), AW (gluten)
  diets?: Diet[];
  labels_required?: string[];
  origin?: string; // ISO code, e.g. 'fi'
};

export type Product = {
  id: string; gtin: string | null; name_fi: string | null; name_en: string | null; name_sv: string | null;
  brand: string | null; vendor: string | null; category: string; origin: string | null;
  sales_unit: string; base_unit: string; lot_size: number; content_l: number | null; content_kg: number | null;
  temperature: number | null; vat_code: string | null;
  contains: string[]; may_contain: string[]; free_from: string[]; has_allergen_statement: boolean;
  claims: string[]; labels: string[]; co2_per_kg: number | null; reliability: number | null;
};

const GLUTEN = ['AW', 'UW', 'GB', 'NR', 'GO', 'ST'];

function toProduct(r: any): Product {
  for (const k of ['contains', 'may_contain', 'free_from', 'claims', 'labels']) r[k] = JSON.parse(r[k]);
  r.has_allergen_statement = !!r.has_allergen_statement;
  return { ...r };
}

/** Reasons a product breaks the limits; empty = eligible. Missing allergen data counts as a breach (§8.1 rule 1, E8). */
export function ineligibility(p: Product, l: Limits): string[] {
  const reasons: string[] = [];
  const present = (code: string) => p.contains.includes(code) || p.may_contain.includes(code);
  if ((l.exclude_allergens?.length || l.diets?.length) && !p.has_allergen_statement) reasons.push('allergen data missing');
  for (const a of l.exclude_allergens ?? []) {
    // Lactose (ML) is milk sugar: a product listing it contains milk even when the data omits AM (seen: goat cheese 473013).
    const codes = a === 'AM' ? ['AM', 'ML'] : [a];
    if (codes.some((c) => p.contains.includes(c))) reasons.push(`contains allergen ${a}`);
    else if (codes.some((c) => p.may_contain.includes(c))) reasons.push(`may contain allergen ${a}`);
  }
  for (const d of l.diets ?? []) {
    const ok =
      d === 'lactose_free' ? p.claims.includes('FREE_FROM_LACTOSE') || p.free_from.includes('ML') || (p.has_allergen_statement && !present('AM'))
      : d === 'gluten_free' ? p.claims.includes('FREE_FROM_GLUTEN') || p.free_from.includes('AW') || (p.has_allergen_statement && !GLUTEN.some(present))
      : d === 'vegan' ? p.claims.includes('VEGAN')
      : p.claims.includes('VEGETARIAN');
    if (!ok) reasons.push(`not ${d.replace('_', '-')}`);
  }
  for (const lb of l.labels_required ?? []) if (!p.labels.includes(lb)) reasons.push(`label ${lb} missing`);
  if (l.origin && p.origin !== l.origin) reasons.push(`origin ${p.origin ?? 'unknown'}, not ${l.origin}`);
  return reasons;
}

/**
 * §7.1 step 1: full-text search over fi/en/sv names (trigram, so Finnish compounds match: maito → kevytmaitojuoma),
 * all terms first, any term as fallback. The category most hits fall into is ranked first (no product taxonomy
 * exists; categories are the closest thing). Only name matches are returned: a category neighbour is not what was
 * asked for (kauraleipä must never become wheat toast). Then eligibility, top `limit`.
 */
export function search(db: DatabaseSync, text: string, limits: Limits = {}, limit = 50, pool = 200) {
  // Trigram FTS needs ≥3 chars per term; quote terms so user text cannot inject FTS syntax.
  const terms = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 3).map((t) => `"${t}"`);
  if (!terms.length) return { category: null, matches: [] as Product[], excluded: [] as { product: Product; reasons: string[] }[] };
  const fts = db.prepare(
    `SELECT p.* FROM products_fts f JOIN products p ON p.id = f.id
     WHERE products_fts MATCH ? ORDER BY bm25(products_fts), p.id LIMIT 2000`,
  );
  let rows: any[] = fts.all(terms.join(' AND '));
  if (!rows.length) rows = fts.all(terms.join(' OR '));

  const votes = new Map<string, number>();
  for (const r of rows) votes.set(r.category, (votes.get(r.category) ?? 0) + 1);
  const category = [...votes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
  // Stable sort: categories with more hits first, bm25 order inside.
  rows = rows.map((r, i) => ({ r, i }))
    .sort((a, b) => votes.get(b.r.category)! - votes.get(a.r.category)! || a.i - b.i)
    .slice(0, pool).map((x) => x.r);

  const matches: Product[] = [];
  const excluded: { product: Product; reasons: string[] }[] = [];
  for (const r of rows) {
    const p = toProduct(r);
    const reasons = ineligibility(p, limits);
    if (reasons.length) excluded.push({ product: p, reasons });
    else if (matches.length < limit) matches.push(p);
  }
  return { category, matches, excluded };
}

export function getProduct(db: DatabaseSync, id: string): Product | null {
  const r = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  return r ? toProduct(r) : null;
}
