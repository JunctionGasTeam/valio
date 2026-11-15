// Offer client for the mock API (context.md §2.3, §7.3, §12). The only module that calls Valio.
// Always asks the API; the cache is the fallback (E9) and the recorded demo backup (§11.3).
import type { DatabaseSync } from 'node:sqlite';

const UNKNOWN_AMOUNT = 999999; // organisers: >= this means "unknown, any quantity" (§2.1)
export const now = () => new Date(process.env.DEMO_NOW ?? Date.now()); // fixed demo clock (§11.3)

export type OfferException = 'E2' | 'E3' | 'E5' | 'E6' | 'E7' | 'E9';
export type Offer = {
  id: string;
  price_cents: number | null;       // catalogPrice per sales unit, ex-VAT
  comparison_cents: number | null;  // per comparison_unit
  comparison_unit: 'KG' | 'L' | null;
  vat_pct: number | null;
  price_valid_to: string | null;
  logistic_model: string | null;
  closing_time: string | null;
  available_date: string | null;
  available_amount: number | null;  // in sales units; null = unknown (E5)
  sales_unit: string | null;
  exceptions: OfferException[];
  fetched_at: string | null;
  from_cache: boolean;
};

type Fetched = { r: any; at: string; cached: boolean };

async function post(endpoint: string, ids: string[], date: string): Promise<any[]> {
  const call = () => fetch(`${(process.env.VALIO_API_BASE ?? '').replace(/\/$/, '')}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'X-API-Key': process.env.VALIO_API_KEY ?? '', 'content-type': 'application/json' },
    body: JSON.stringify({ customer: 'earnest', requestedDate: date, products: ids }),
    signal: AbortSignal.timeout(Number(process.env.VALIO_TIMEOUT_MS ?? 10_000)), // demo knob: lower it if venue Wi-Fi is slow
  });
  let res = await call();
  if (res.status === 429) { await new Promise((r) => setTimeout(r, 30_000)); res = await call(); } // 429 blocks the caller for 30 s (§2.1)
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ((await res.json()) as { products: any[] }).products;
}

/** Price + availability for a shortlist on one date. Sequential calls, so no bursts (§2.1). */
export async function checkOffers(db: DatabaseSync, ids: string[], date: string) {
  if (ids.length < 1 || ids.length > 50) throw new RangeError('check_offers takes 1..50 product ids (§12)');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RangeError('date must be YYYY-MM-DD');
  const errors: string[] = [];
  const get = async (endpoint: 'price' | 'availability') => {
    const out = new Map<string, Fetched>();
    try {
      const rows = await post(endpoint, ids, date);
      const at = new Date().toISOString();
      const put = db.prepare('INSERT OR REPLACE INTO offer_cache VALUES (?,?,?,?,?)');
      for (const r of rows) { put.run(endpoint, r.productId, date, JSON.stringify(r), at); out.set(r.productId, { r, at, cached: false }); }
    } catch (e) {
      errors.push(`${endpoint}: ${(e as Error).message}; serving cached responses`);
      const read = db.prepare('SELECT response, fetched_at FROM offer_cache WHERE endpoint = ? AND product = ? AND date = ?');
      for (const id of ids) {
        const c = read.get(endpoint, id, date) as { response: string; fetched_at: string } | undefined;
        if (c) out.set(id, { r: JSON.parse(c.response), at: c.fetched_at, cached: true });
      }
    }
    return out;
  };
  const price = await get('price');
  const avail = await get('availability');
  return { errors, offers: ids.map((id) => toOffer(id, date, price.get(id), avail.get(id))) };
}

const cents = (x?: { value: number } | null) => (x ? Math.round(x.value * 100) : null);

function toOffer(id: string, date: string, p?: Fetched, a?: Fetched): Offer {
  const pr = p?.r, av = a?.r, line = av?.scheduleLines?.[0];
  const ex = new Set<OfferException>();
  const priced = pr && !pr.error && pr.catalogPrice;
  if (!p) ex.add('E9'); else if (!priced) ex.add('E7');
  if (!a) ex.add('E9');
  else if (!line || av.salesBlock || line.salesBlock || !line.availableAmount) ex.add('E2');
  else {
    if (line.availableDate && line.availableDate > date) ex.add('E3');
    if (line.availableAmount >= UNKNOWN_AMOUNT) ex.add('E5');
    if (av.closingTime && Date.parse(av.closingTime) < now().getTime()) ex.add('E6');
  }
  return {
    id,
    price_cents: priced ? cents(pr.catalogPrice) : null,
    comparison_cents: priced ? cents(pr.comparisonPrice) : null,
    comparison_unit: priced ? pr.comparisonUnit ?? null : null,
    vat_pct: pr?.tax?.taxRate ?? null,
    price_valid_to: priced ? pr.catalogPrice.validTo : null,
    logistic_model: av?.logisticModel ?? null,
    closing_time: av?.closingTime ?? null,
    available_date: line?.availableDate ?? null,
    available_amount: !line ? 0 : line.availableAmount >= UNKNOWN_AMOUNT ? null : line.availableAmount,
    sales_unit: line?.salesUnit ?? null,
    exceptions: [...ex],
    fetched_at: [p?.at, a?.at].filter(Boolean).sort()[0] ?? null,
    from_cache: !!(p?.cached || a?.cached),
  };
}
