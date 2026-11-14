// One-off: picks 15 simple Valio Aimo recipes and writes data/recipes.json (`npm run recipes`, online, ~2 min).
// Valio website content: kept in data/ (gitignored), never published. Ingredient names are normalised by the model
// when a key is set, else by rules; check the file by eye before a demo.
import { writeFileSync } from 'node:fs';
import { openDb } from './db.ts';
import { search } from './catalogue.ts';
import { normalizeIngredients } from './llm.ts';
import { parseLine, recipesPath, type Recipe, type RecipeLine } from './recipes.ts';

const SITE = 'https://www.valioaimo.fi';
const LIST = `${SITE}/valio-search-client/recipes/?account=valioaimo&keittiotyyppi=ammattikeittiot`;
// course facet → how many recipes; a mix so the page has something for every part of a lunch.
const QUOTA: [string, string, number][] = [
  ['Soup', 'ruokalaji=keitot', 3], ['Main course', 'ruokalaji=paaruoat', 4], ['Salad', 'ruokalaji=salaatit', 2],
  ['Side dish', 'ruokalaji=lisakeruoat', 2], ['Dessert', 'ruokalaji=jalkiruoat', 2], ['Vegan', 'erityisruokavaliot=vegaaninen', 2],
];
const MAX_LINES = 10, MIN_COVERAGE = 0.8;
const ALCOHOL = /tequila|viini(?!etikka)|rommi|konjak|olut|likööri|vodka|snapsi/i; // hard rule 4: keep the demo recipes out of it
// ponytail: hand-picked exclusions after reading the first run (near-duplicate pizza dough). Revisit when re-fetching.
const SKIP = /pizza\s+al\s+taglio/i; // \s: the title has a non-breaking space

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const get = async (url: string) => {
  await sleep(700); // be gentle: one request at a time
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (Junction 2026 demo)' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res;
};
const decode = (s: string) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');
const tokens = (s: string) => decode(s).toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
const words = (s: string) => tokens(s).filter((w) => w.length >= 4 && w !== 'valio');
// ponytail: crude rules fallback for need (drop brand words, strip Finnish partitive). The model does this better.
const ruleNeed = (name: string) => name.split(/\s+/).filter((w) => !/®|™|valio/i.test(w)).map((w) => w.replace(/(?:ja|jä|ta|tä|a|ä)$/i, '')).join(' ').toLowerCase();

const db = openDb();
const gtin = db.prepare('SELECT id, name_fi FROM products WHERE gtin = ? OR gtin = ?');
const picked: Recipe[] = [];
const seen = new Set<string>();

for (const [course, facet, n] of QUOTA) {
  let got = 0;
  const items: any[] = [];
  for (let url: string | null = `${LIST}&${facet}`, page = 0; url && page < 3; page++) {
    const list = (await (await get(url)).json()) as any;
    items.push(...list.items);
    url = list.nextPage ?? null;
  }
  for (const item of items) {
    if (got === n) break;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const html = await (await get(new URL(item.url, SITE).href)).text();
    const ld = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)]
      .flatMap((m) => { try { const j = JSON.parse(m[1]); return j['@graph'] ?? [j]; } catch { return []; } })
      .find((x: any) => x['@type'] === 'Recipe');
    const yieldN = parseInt(String(ld?.recipeYield ?? ''), 10);
    const texts: string[] = ld?.recipeIngredient ?? [];
    const parsed = texts.map(parseLine);
    if (!yieldN || texts.length < 3 || texts.length > MAX_LINES || parsed.some((p) => !p) || texts.some((t) => ALCOHOL.test(t))) continue;

    const ai = await normalizeIngredients(texts);
    const lines: RecipeLine[] = texts.map((text, i) => ({
      text, kg: parsed[i]!.kg, product: null,
      need: ai ? (ai[i].skip ? null : ai[i].need.trim().toLowerCase()) : /vettä|vesi/i.test(parsed[i]!.name) ? null : ruleNeed(parsed[i]!.name),
      pantry: ai ? ai[i].pantry : /suola|pippuri|öljy/i.test(parsed[i]!.name),
    }));
    // Valio products the recipe names (EANs in the listing) → the line sharing the most words with the product name.
    const analytics = JSON.parse(item.analyticsObject ?? '{}');
    for (const ean of String(analytics.product_ean ?? '').split(/,\s*/).filter(Boolean)) {
      const p = gtin.get(ean, ean.padStart(14, '0')) as { id: string; name_fi: string } | undefined;
      if (!p) continue;
      const pw = words(p.name_fi);
      // The product name containing the line's need as a whole word wins (puolukka ≠ puolukkakeitto), then shared prefixes.
      const all = tokens(p.name_fi);
      const score = (l: RecipeLine) => (tokens(l.need!).every((w) => all.includes(w)) ? 10 : 0)
        + words(l.text).filter((w) => pw.some((x) => x.startsWith(w.slice(0, 5)) || w.startsWith(x.slice(0, 5)))).length;
      const best = lines.filter((l) => l.need && !l.product).sort((a, b) => score(b) - score(a))[0];
      if (best && score(best) > 0) best.product = p.id;
    }
    const buy = lines.filter((l) => l.need && !l.pantry);
    const found = buy.filter((l) => l.product || search(db, l.need!, {}, 1).matches.length);
    const coverage = buy.length ? found.length / buy.length : 0;
    const name = decode(ld.name ?? item.title);
    const ok = coverage >= MIN_COVERAGE && !/testi/i.test(name) && !SKIP.test(name);
    console.log(`${ok ? '✓' : '·'} ${course.padEnd(11)} ${name} (${texts.length} lines, ${Math.round(coverage * 100)} % in catalogue)`);
    if (!ok) continue;
    picked.push({
      id: String(item.extId), name, url: new URL(item.url, SITE).href, image: item.image ?? null, yield: yieldN,
      course, diets: String(analytics.recipe_diet ?? '').split(/,\s*/).filter(Boolean), lines,
    });
    got++;
  }
  if (got < n) console.warn(`only ${got} of ${n} for ${course}`);
}

writeFileSync(recipesPath(), JSON.stringify(picked, null, 1));
console.log(`\n${picked.length} recipes → ${recipesPath()} (ingredient names by ${process.env.GEMINI_API_KEY ? 'model' : 'rules'})`);
