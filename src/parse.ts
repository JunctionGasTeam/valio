// Text → PurchaseRequest without a model (context.md §4, §6): the deterministic fallback and the keyword detector
// whose diet/allergen findings are always added to any request (a model or agent can add limits, never drop them).
import { now } from './offers.ts';
import type { Diet } from './catalogue.ts';
import type { Priorities, Unit } from './planner.ts';

const DIETS: [Diet, RegExp][] = [
  ['lactose_free', /lactose[- ]?free|laktoosit(?:on|tom)|laktosfri/i],
  ['gluten_free', /gluten[- ]?free|gluteenit(?:on|tom)|glutenfri/i],
  ['vegan', /\bvegan|vegaani|vegansk/i],
  ['vegetarian', /vegetarian|kasvis|vegetarisk/i],
];
// GS1 allergen codes (open question 15.3: mapping to be confirmed by Valio). "X-free", "no X", "without X", Finnish "-ton".
const ALLERGENS: [string, string][] = [
  ['AM', 'milk|dairy|maido|maitotuotteet|mjölk'], ['AW', 'wheat|vehnä|vete'], ['AE', 'eggs?|kananmuna|muna|ägg'],
  ['AN', 'nuts?|tree nuts|pähkinä|nötter'], ['AP', 'peanuts?|maapähkinä|jordnöt'], ['AF', 'fish|kala|fisk'],
  ['AC', 'shellfish|crustaceans?|äyriäi'], ['AY', 'soy|soya|soija|soja'], ['AS', 'sesame|seesami|sesam'],
  ['BC', 'celery|selleri'], ['BM', 'mustard|sinappi|senap'],
];
const free = (words: string) =>
  new RegExp(`(?:\\b(?:${words})[- ]?free\\b|\\b(?:no|without|free of|ilman|utan)\\s+(?:${words})\\b|\\b(?:${words})[a-zäö]*?(?:t[oö]n|tt[oö]m))`, 'i'); // -ton/-tön, inflected -ttom-/-ttöm-

export function detectLimits(text: string) {
  return {
    diets: DIETS.filter(([, re]) => re.test(text)).map(([d]) => d),
    exclude_allergens: ALLERGENS.filter(([, w]) => free(w).test(text)).map(([c]) => c),
  };
}

const UNIT: [RegExp, Unit][] = [[/^(l|litres?|liters?|litraa?|ltr)$/i, 'l'], [/^(kg|kilos?|kilograms?|kiloa?)$/i, 'kg'], [/^(pcs|pieces?|kpl|units?|st)$/i, 'pcs']];
const QTY = /(\d{1,3}(?:[ ,. ]\d{3})+|\d+(?:[.,]\d+)?)\s*(litres?|liters?|litraa?|ltr|l|kilograms?|kilos?|kiloa?|kg|pcs|pieces?|kpl|units?)\b/gi;
const STOP = /\b(?:by|for|before|until|on|mennessä|ennen|ja|and|och|delivered|best|cheapest|please|kiitos)\b|[,.;!?]|\b\d/i;
const FILLER = /\b(?:of|a|an|the|some|lactose[- ]?free|gluten[- ]?free|laktoosit\w*|gluteenit\w*|vegan|vegaani\w*|vegetarian|kasvis\w*|organic)\b/gi;
const DAYS = [/sunday|sunnuntai|söndag/i, /monday|maanantai|måndag/i, /tuesday|tiistai|tisdag/i, /wednesday|keskiviikko|onsdag/i,
  /thursday|torstai|torsdag/i, /friday|perjantai|fredag/i, /saturday|lauantai|lördag/i];

const number = (s: string) => Number(/^\d{1,3}([ ,. ]\d{3})+$/.test(s) ? s.replace(/[ ,. ]/g, '') : s.replace(',', '.'));
const iso = (d: Date) => d.toISOString().slice(0, 10);
// ponytail: crude Finnish case stripping (maitoa → maito, jauhoja → jauho). Search is substring-based, so a shorter
// stem only widens the match. Replace with the model's normalised need when an LLM is configured.
const stem = (w: string) => (w.length >= 6 ? w.replace(/(?:ja|jä|ta|tä|a|ä)$/i, '') : w);

function deliverBy(text: string): string | undefined {
  const today = new Date(`${now().toLocaleDateString('en-CA', { timeZone: 'Europe/Helsinki' })}T12:00:00Z`);
  const isoDate = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoDate) return isoDate[1];
  const fi = text.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})?/);
  if (fi) {
    const d = new Date(Date.UTC(fi[3] ? +fi[3] : today.getUTCFullYear(), +fi[2] - 1, +fi[1], 12));
    if (!fi[3] && d < today) d.setUTCFullYear(d.getUTCFullYear() + 1);
    return iso(d);
  }
  if (/tomorrow|huomenna|i morgon/i.test(text)) return iso(new Date(+today + 864e5));
  const day = DAYS.findIndex((re) => re.test(text));
  if (day >= 0) return iso(new Date(+today + (((day - today.getUTCDay() + 7) % 7) || 7) * 864e5));
  return undefined;
}

export function parseRequest(text: string) {
  const items: { need: string; quantity: number; unit: Unit }[] = [];
  for (const m of text.matchAll(QTY)) {
    const rest = text.slice(m.index! + m[0].length);
    const need = rest.split(STOP)[0].replace(FILLER, ' ').split(/\s+/).filter(Boolean).map(stem).join(' ').trim();
    items.push({ need, quantity: number(m[1]), unit: UNIT.find(([re]) => re.test(m[2]))![1] });
  }
  const priorities: Priorities = /sustainab|co2|climate|ilmasto|vastuul|hållbar/i.test(text) ? 'sustainability'
    : /reliab|luotett|pålitlig/i.test(text) ? 'reliability_first' : 'price_and_availability';
  const request = { deliver_by: deliverBy(text), items, priorities, source_text: text, ...detectLimits(text) };
  const clarification = !items.length ? 'How much do you need, and in which unit (l, kg or pieces)?'
    : items.some((i) => !i.need) ? 'Which product do you mean?'
    : items.some((i) => !(i.quantity > 0)) ? 'The quantity must be more than zero. How much do you need?' : null;
  return { request, clarification, parser: 'rules' as const };
}
