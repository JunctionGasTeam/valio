// Recipes (context.md §4b): 15 Valio Aimo professional-kitchen recipes, fetched once into data/recipes.json
// (`npm run recipes`; Valio content, never committed). Scaling a recipe to N portions gives purchase items in kg.
import { existsSync, readFileSync } from 'node:fs';

export type RecipeLine = {
  text: string;            // as written: "0,900 kg täysjyväpastaa"
  kg: number;              // per recipe yield
  need: string | null;     // what to buy; null = nothing to buy (water, "to taste")
  pantry: boolean;         // basic seasoning a kitchen usually has: left out unless asked for
  product: string | null;  // Valio product the recipe names (by EAN), preferred when deliverable
};
export type Recipe = {
  id: string; name: string; url: string; image: string | null; yield: number;
  course: string; diets: string[]; lines: RecipeLine[];
};

export const recipesPath = () => process.env.RECIPES_PATH ?? 'data/recipes.json';
let cache: { path: string; recipes: Recipe[] } | null = null;
export function loadRecipes(): Recipe[] {
  const path = recipesPath();
  if (cache?.path !== path) cache = { path, recipes: existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [] };
  return cache.recipes;
}

/** "0,900 kg täysjyväpastaa, hienonnettuna" → kg 0.9, name "täysjyväpastaa". null when it is not "<number> kg <name>". */
export function parseLine(text: string) {
  const m = text.trim().match(/^(\d+(?:[.,]\d+)?)\s*kg\s+(.+)$/i);
  if (!m) return null;
  return { kg: Number(m[1].replace(',', '.')), name: m[2].split(/,|\(/)[0].trim() };
}

/**
 * Recipe × portions → purchase items. Quantities are kg, rounded up to 10 g; every item says where its number came from.
 * Lines with nothing to buy, or pantry lines not in `pantry`, are listed as skipped with the reason.
 */
export function scaleRecipe(r: Recipe, portions: number, pantry: string[] = []) {
  const factor = portions / r.yield;
  const items: { need: string; quantity: number; unit: 'kg'; kg: number; lines: string[]; product: string | null; from: string }[] = [];
  const skipped: { text: string; reason: string }[] = [];
  for (const l of r.lines) {
    if (!l.need || l.kg <= 0) { skipped.push({ text: l.text, reason: l.kg <= 0 ? 'to taste' : 'nothing to buy' }); continue; }
    if (l.pantry && !pantry.includes(l.need)) { skipped.push({ text: l.text, reason: 'usually in stock' }); continue; }
    // The same ingredient on two lines (some recipes list it per step) is one purchase.
    const same = items.find((it) => it.need === l.need && it.product === l.product);
    if (same) { same.kg += l.kg; same.lines.push(l.text); } else items.push({ need: l.need, quantity: 0, unit: 'kg', kg: l.kg, lines: [l.text], product: l.product, from: '' });
  }
  for (const it of items) {
    it.quantity = Math.ceil(+(it.kg * factor * 100).toFixed(6)) / 100; // up to 10 g
    it.from = `${it.lines.join(' + ')} × ${portions}/${r.yield} portions = ${it.quantity} kg`;
  }
  return { factor, items, skipped };
}
