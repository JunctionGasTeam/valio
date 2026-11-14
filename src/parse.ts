// Text → PurchaseRequest without a model (context.md §4, §6): the deterministic fallback and the keyword detector
// whose diet/allergen findings are always added to any request (a model or agent can add limits, never drop them).
import { now } from './offers.ts';
import type { Diet } from './catalogue.ts';
import type { Priorities, Unit } from './planner.ts';
import { llmModel, parseWithModel } from './llm.ts';

const DIETS: [Diet, RegExp][] = [
  ['lactose_free', /lactose[- ]?free|laktoosit(?:on|tom)|laktosfri/i],
  ['gluten_free', /gluten[- ]?free|gluteenit(?:on|tom)|glutenfri/i],
  ['vegan', /\bvegan|vegaani|vegansk/i],
  ['vegetarian', /vegetarian|kasvis|vegetarisk/i],
];
// GS1 allergen codes (open question 15.3: mapping to be confirmed by Valio). "X-free", "no X", "without X", Finnish "-ton".
const ALLERGENS: [string, string][] = [
  ['AM', 'milk|dairy|maito|maido|maitotuotteet|mjölk'], ['AW', 'wheat|vehnä|vete'], ['AE', 'eggs?|kananmuna|muna|ägg'],
  ['AN', 'nuts?|tree nuts|pähkinä|nötter'], ['AP', 'peanuts?|maapähkinä|jordnöt'], ['AF', 'fish|kala|fisk'],
  ['AC', 'shellfish|crustaceans?|äyriäi'], ['AY', 'soy|soya|soija|soja'], ['AS', 'sesame|seesami|sesam'],
  ['BC', 'celery|selleri'], ['BM', 'mustard|sinappi|senap'],
];
const free = (words: string) => new RegExp(
  `(?:\\b(?:${words})[- ]?free\\b|\\b(?:no|without|free of|ilman|utan)\\s+(?:${words})\\b|\\b(?:${words})[a-zäö]*?(?:t[oö]n|tt[oö]m)` // -ton/-tön, -ttom-
  + `|\\b(?:${words})[a-zäö]*[- ]?(?:allerg|allergi)|allerg(?:y|ic|ia|isk)\\s+(?:to\\s+|mot\\s+)?(?:${words}))`, 'i'); // milk allergy, maitoallergia, allergic to nuts

export function detectLimits(text: string) {
  return {
    diets: DIETS.filter(([, re]) => re.test(text)).map(([d]) => d),
    exclude_allergens: ALLERGENS.filter(([, w]) => free(w).test(text)).map(([c]) => c),
  };
}

const UNIT: [RegExp, Unit][] = [[/^(l|litres?|liters?|litraa?|ltr)$/i, 'l'], [/^(kg|kilos?|kilograms?|kiloa?)$/i, 'kg'], [/^(pcs|pieces?|kpl|units?|st)$/i, 'pcs']];
const QTY = /(\d{1,3}(?:[ ,. ]\d{3})+|\d+(?:[.,]\d+)?)\s*(litres?|liters?|litraa?|ltr|l|kilograms?|kilos?|kiloa?|kg|pcs|pieces?|kpl|units?)\b/gi;
const STOP = /\b(?:by|for|before|until|on|mennessä|ennen|ja|and|och|delivered|best|cheapest|please|kiitos|tomorrow|today|huomenna|tänään|imorgon|morgon|idag|(?:mon|tues|wednes|thurs|fri|satur|sun)day|(?:maanan|tiis|lauan|sunnun)tai\w*|keskiviikko\w*|torstai\w*|perjantai\w*|(?:mån|tis|ons|tors|fre|lör|sön)dag\w*)\b|[,.;!?]|\b\d/i;
const FILLER = /\b(?:of|a|an|the|some|lactose[- ]?free|gluten[- ]?free|laktoosit\w*|gluteenit\w*|vegan|vegaani\w*|vegetarian|kasvis\w*|organic)\b/gi;
const DAYS = [/sunday|sunnuntai|söndag/i, /monday|maanantai|måndag/i, /tuesday|tiistai|tisdag/i, /wednesday|keskiviikko|onsdag/i,
  /thursday|torstai|torsdag/i, /friday|perjantai|fredag/i, /saturday|lauantai|lördag/i];

const number = (s: string) => Number(/^\d{1,3}([ ,. ]\d{3})+$/.test(s) ? s.replace(/[ ,. ]/g, '') : s.replace(',', '.'));
const iso = (d: Date) => d.toISOString().slice(0, 10);
// ponytail: crude Finnish case stripping (maitoa → maito, jauhoja → jauho). Search is substring-based, so a shorter
// stem only widens the match. Replace with the model's normalised need when an LLM is configured.
const stem = (w: string) => (w.length >= 6 ? w.replace(/(?:ja|jä|ta|tä|a|ä)$/i, '') : w);

const helsinkiToday = () => now().toLocaleDateString('en-CA', { timeZone: 'Europe/Helsinki' });

function deliverBy(text: string): string | undefined {
  const today = new Date(`${helsinkiToday()}T12:00:00Z`);
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

type NumPart = [number, 'unit' | 'teen' | 'tens' | 'hundred' | 'thousand'];
// Number words → digits, so spoken requests ("a thousand litres", "kaksisataa litraa", "tvåhundra liter") parse and
// check like typed ones. Finnish and Swedish write numbers as one compound word, so each word is split into parts.
const NUM_PARTS = ([
  ...['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'].map((w, i) => [w, i, 'unit'] as const),
  ...['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'].map((w, i) => [w, 10 + i, 'unit'] as const),
  ...['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'].map((w, i) => [w, 20 + 10 * i, 'unit'] as const),
  ['hundred', 100, 'hundred'], ['thousand', 1000, 'thousand'],
  // Finnish: yksi … yhdeksän, -toista (11–19), -kymmentä (tens), sata/-sataa, tuhat/-tuhatta
  ...['yksi', 'kaksi', 'kolme', 'neljä', 'viisi', 'kuusi', 'seitsemän', 'kahdeksan', 'yhdeksän'].map((w, i) => [w, 1 + i, 'unit'] as const),
  ['kymmenen', 10, 'unit'], ['toista', 10, 'teen'], ['kymmentä', 10, 'tens'], ['sataa', 100, 'hundred'], ['sata', 100, 'hundred'],
  ['tuhatta', 1000, 'thousand'], ['tuhat', 1000, 'thousand'],
  // Swedish
  ...['en', 'ett', 'två', 'tre', 'fyra', 'fem', 'sex', 'sju', 'åtta', 'nio'].map((w, i) => [w, i < 2 ? 1 : i, 'unit'] as const),
  ...['tio', 'elva', 'tolv', 'tretton', 'fjorton', 'femton', 'sexton', 'sjutton', 'arton', 'nitton'].map((w, i) => [w, 10 + i, 'unit'] as const),
  ...['tjugo', 'trettio', 'fyrtio', 'femtio', 'sextio', 'sjuttio', 'åttio', 'nittio'].map((w, i) => [w, 20 + 10 * i, 'unit'] as const),
  ['hundra', 100, 'hundred'], ['tusen', 1000, 'thousand'],
] as [string, number, NumPart[1]][]).sort((a, b) => b[0].length - a[0].length); // longest first: "seitsemän" before "sex"

/** A word made only of number parts ("kaksisataaviisikymmentä" → kaksi, sataa, viisi, kymmentä), else null. */
function numberParts(word: string): NumPart[] | null {
  if (!word) return [];
  for (const [part, v, kind] of NUM_PARTS) {
    if (!word.startsWith(part)) continue;
    const rest = numberParts(word.slice(part.length));
    if (rest) return [[v, kind], ...rest];
  }
  return null;
}
/** "two hundred and fifty litres" → "250 litres". The person's own words are kept elsewhere; this is for parsing and checks. */
export function numbersToDigits(text: string) {
  const tokens = text.split(/(\s+)/);
  const out: string[] = [];
  let run: { total: number; cur: number; last: number } | null = null;
  let held: string[] = []; // spaces (and "and") inside a number, dropped if the number goes on
  const end = () => { if (run) out.push(String(run.total + run.cur)); run = null; out.push(...held); held = []; };
  const apply = ([v, kind]: NumPart) => {
    const r = run!;
    if (kind === 'unit') { r.cur += v; r.last = v; }
    else if (kind === 'teen') { r.cur += 10; r.last = 0; }                         // yksi|toista = 11
    else if (kind === 'tens') { r.cur += r.last * 9; r.last = 0; }                 // kaksi|kymmentä = 20
    else if (kind === 'hundred') { r.cur += (r.last || 1) * 100 - r.last; r.last = 0; }
    else { r.total += (r.cur || 1) * 1000; r.cur = 0; r.last = 0; }
  };
  const nextWord = (i: number) => tokens.slice(i + 1).find((t) => t && !/^\s+$/.test(t)) ?? '';
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (/^\s+$/.test(t)) { (run ? held : out).push(t); continue; }
    const m = t.match(/^(\p{L}+(?:-\p{L}+)*)([^\p{L}]*)$/u);
    const word = m?.[1].toLowerCase() ?? '';
    const next = nextWord(i).toLowerCase();
    if (run && word === 'and' && numberParts(next.replace(/[^\p{L}]/gu, ''))) { held.push(t); continue; } // two hundred and fifty
    const parts = (word === 'a' || word === 'an') && /^(hundred|thousand)\b/.test(next) ? [[1, 'unit'] as NumPart]
      : m ? word.split('-').reduce<NumPart[] | null>((acc, w) => { const p = numberParts(w); return acc && p && p.length ? [...acc, ...p] : null; }, [])
      : null;
    if (parts && parts.length) {
      if (run) held = []; else run = { total: 0, cur: 0, last: 0 };
      parts.forEach(apply);
      if (m![2]) { end(); out.push(m![2]); }
      continue;
    }
    end();
    out.push(t);
  }
  end();
  return out.join('');
}

export function parseRequest(raw: string) {
  const text = numbersToDigits(raw);
  const items: { need: string; quantity: number; unit: Unit }[] = [];
  for (const m of text.matchAll(QTY)) {
    const rest = text.slice(m.index! + m[0].length);
    const need = rest.split(STOP)[0].replace(FILLER, ' ').split(/\s+/).filter(Boolean).map(stem).join(' ').trim();
    items.push({ need, quantity: number(m[1]), unit: UNIT.find(([re]) => re.test(m[2]))![1] });
  }
  const priorities: Priorities = /sustainab|co2|climate|ilmasto|vastuul|hållbar/i.test(text) ? 'sustainability'
    : /reliab|luotett|pålitlig/i.test(text) ? 'reliability_first' : 'price_and_availability';
  const request = { deliver_by: deliverBy(text), items, priorities, source_text: raw, ...detectLimits(text) };
  const clarification = !items.length ? 'How much do you need, and in which unit (l, kg or pieces)?'
    : items.some((i) => !i.need) ? 'Which product do you mean?'
    : items.some((i) => !(i.quantity > 0)) ? 'The quantity must be more than zero. How much do you need?' : null;
  return { request, clarification, parser: 'rules' as const };
}

/**
 * Rules + model (§4 job 1). The model names the product (oat bread → kauraleipä); whatever the rules found wins:
 * quantities, units and date when they found them, and diet/allergen limits are always unioned. Model off → rules.
 */
export async function parseText(text: string) {
  const rules = parseRequest(text);
  const ai = await parseWithModel(text, helsinkiToday());
  if (!ai) return rules;
  const r = rules.request;
  const items = ai.items
    .map((it, i) => (r.items.length === ai.items.length ? { need: it.need, quantity: r.items[i].quantity, unit: r.items[i].unit } : it))
    .filter((it) => it.need?.trim() && it.quantity > 0 && ['l', 'kg', 'pcs'].includes(it.unit))
    .map((it) => ({ ...it, need: it.need.trim().toLowerCase() }));
  const request = {
    ...r, items,
    deliver_by: r.deliver_by ?? (/^\d{4}-\d{2}-\d{2}$/.test(ai.deliver_by) ? ai.deliver_by : undefined),
    priorities: r.priorities !== 'price_and_availability' ? r.priorities : ai.priorities ?? r.priorities,
    diets: [...new Set([...r.diets, ...(ai.diets ?? [])])],
    exclude_allergens: [...new Set([...r.exclude_allergens, ...(ai.exclude_allergens ?? [])])],
  };
  // Models sometimes read "lactose-free" as a milk allergy, which excludes all milk. A limit is never dropped
  // (it may be a real allergy the rules missed): ask instead.
  const milkConflict = request.diets.includes('lactose_free') && request.exclude_allergens.includes('AM') && !r.exclude_allergens.includes('AM');
  const clarification = !items.length ? (ai.clarification || rules.clarification || 'Which product do you need, and how much?')
    : milkConflict ? 'Lactose-free only, or must it be free of all milk (a milk allergy)? Say "milk allergy" if so.' : null;
  return { request, clarification, parser: `rules+${llmModel()}` };
}

/** Is `q` a number the person wrote? 1,000 → 1000; 500 g → 0.5 kg and 5 dl → 0.5 l count, but only with those units. */
export function quantityInText(raw: string, q: number) {
  const text = numbersToDigits(raw);
  const nums = [...text.matchAll(/(\d{1,3}(?:[ ,.]\d{3})+(?![.,]?\d)|\d+(?:[.,]\d+)?)\s*(g|grams?|grammaa?|ml|dl|cl)?\b/gi)].map((m) => {
    const n = number(m[1]), u = m[2]?.toLowerCase();
    return !u ? n : u === 'dl' ? n / 10 : u === 'cl' ? n / 100 : n / 1000;
  });
  return nums.some((n) => Math.abs(n - q) < 1e-9);
}

/**
 * Read-back (trust): what the original text says vs the structured request the agent or model built from it.
 * Deterministic, so it also checks an outside agent's interpretation. null without a source text.
 */
export function readBack(r: {
  source_text?: string; items: { need: string; quantity: number; unit: Unit }[]; deliver_by: string; deliver_by_defaulted?: boolean;
  diets: Diet[]; exclude_allergens: string[]; priorities: Priorities;
}) {
  const text = r.source_text;
  if (!text) return null;
  const rules = parseRequest(text).request;
  const said = detectLimits(text);
  return {
    text,
    items: r.items.map((it, i) => ({
      quantity_in_text: quantityInText(text, it.quantity),
      // The person's own words for the product, when the rules can line them up (oat bread → kauraleipä).
      words: rules.items.length === r.items.length && rules.items[i].need !== it.need ? rules.items[i].need : null,
    })),
    deliver_by: r.deliver_by_defaulted ? 'assumed' : rules.deliver_by === r.deliver_by ? 'text' : 'interpreted',
    added_limits: [...r.diets.filter((d) => !said.diets.includes(d)), ...r.exclude_allergens.filter((a) => !said.exclude_allergens.includes(a))],
    priorities_default: rules.priorities === 'price_and_availability' && r.priorities === 'price_and_availability'
      && !/price|hinta|pris|availab|saatav|tillgäng/i.test(text),
  };
}
