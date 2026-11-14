// Optional LLM (context.md §4): parse text, and check which candidates are the requested product type.
// Gemini through its OpenAI-compatible endpoint by default; any OpenAI-compatible endpoint via env.
// Every function returns null on any failure: callers fall back to rules, the product keeps working.
import type { Diet } from './catalogue.ts';
import type { Priorities, Unit } from './planner.ts';

const env = () => ({
  key: process.env.GEMINI_API_KEY ?? process.env.LLM_API_KEY,
  base: (process.env.LLM_BASE ?? 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/$/, ''),
  model: process.env.LLM_MODEL ?? 'gemini-3.5-flash-lite',
});
export const llmModel = () => (env().key ? env().model : null);

async function ask<T>(system: string, user: unknown, schema: object): Promise<T | null> {
  const { key, base, model } = env();
  if (!key) return null;
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model, temperature: 0, reasoning_effort: 'low',
        messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(user) }],
        response_format: { type: 'json_schema', json_schema: { name: 'answer', schema } },
      }),
      signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS ?? 8000)),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as any;
    return JSON.parse(j.choices[0].message.content) as T;
  } catch {
    return null;
  }
}

// ponytail: process-lifetime memo, so revisions of a proposal do not re-ask the model. Bounded by distinct requests.
const memo = new Map<string, Set<string> | null>();

/** Which candidates are the requested product type. Can only narrow; null = no answer (keep all). */
export async function matchProducts(need: string, candidates: { id: string; name: string }[]): Promise<Set<string> | null> {
  if (!candidates.length) return null;
  const k = `${env().model}|${need}|${candidates.map((c) => c.id).join(',')}`;
  if (!memo.has(k)) {
    const r = await ask<{ matching_ids: string[] }>(
      'A food service buyer asked a Finnish food wholesaler for a product. For each candidate, decide whether it IS that product: '
      + 'the same product type in any brand, size, pack, fat level, fresh or frozen, flavour-neutral variant, organic, gluten-free or lactose-free version '
      + '(names are often abbreviated, e.g. GTON = gluteeniton, PAK = pakaste). '
      + 'Exclude ingredient mixes, accessories, flavoured drinks or desserts that only contain it, and different products. '
      + 'Finnish milk drinks (maitojuoma) count as milk. When unsure, include it: a person reviews the list. Reply with the ids that match.',
      { need, candidates },
      { type: 'object', properties: { matching_ids: { type: 'array', items: { type: 'string' } } }, required: ['matching_ids'] },
    );
    const ids = new Set(candidates.map((c) => c.id));
    memo.set(k, r && Array.isArray(r.matching_ids) ? new Set(r.matching_ids.filter((id) => ids.has(id))) : null);
  }
  return memo.get(k)!;
}

const GS1 = ['AM', 'AW', 'AE', 'AN', 'AP', 'AF', 'AC', 'AY', 'AS', 'BC', 'BM', 'AU', 'NL', 'UM'];
export type ParsedByModel = {
  items: { need: string; quantity: number; unit: Unit }[];
  deliver_by: string; diets: Diet[]; exclude_allergens: string[]; priorities: Priorities; clarification: string;
};

export async function parseWithModel(text: string, today: string): Promise<ParsedByModel | null> {
  const weekday = new Date(`${today}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
  return ask<ParsedByModel>(
    `You turn a purchasing request for a Finnish food wholesaler into JSON. Today is ${today} (${weekday}), Helsinki time.\n`
    + '- items: one per product. need = the short Finnish product noun in base form, as in Finnish product names '
    + '(milk → maito, oat bread → kauraleipä, eggs → kananmuna, butter → voi). Keep words that define the product type '
    + '(kauraleipä, not leipä) but move diets out of need (lactose-free milk → need maito, diets lactose_free).\n'
    + '- quantity as a number, unit l, kg or pcs (convert dl/ml to l and g to kg). Never invent a quantity.\n'
    + '- deliver_by: YYYY-MM-DD if a date, weekday or "tomorrow" is mentioned (a weekday means the next one after today), else "".\n'
    + `- diets from: lactose_free, gluten_free, vegan, vegetarian. exclude_allergens: GS1 codes (${GS1.join(', ')}; AM milk, AW gluten, AE egg, AN tree nuts, AP peanuts, AF fish, AC crustaceans, AY soy, AS sesame, BC celery, BM mustard, AU sulphites, NL lupin, UM molluscs).\n`
    + '- Add an allergen only when the text says to avoid it (allergy, "no X", "X-free" for that allergen). '
    + 'Lactose-free is the diet lactose_free, NOT the milk allergen AM: lactose-free milk still contains milk protein.\n'
    + '- priorities: sustainability, reliability_first or price_and_availability (default).\n'
    + '- clarification: one short question if the product or quantity is missing or ambiguous, else "".',
    { text },
    {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'object', properties: {
          need: { type: 'string' }, quantity: { type: 'number' }, unit: { type: 'string', enum: ['l', 'kg', 'pcs'] },
        }, required: ['need', 'quantity', 'unit'] } },
        deliver_by: { type: 'string' },
        diets: { type: 'array', items: { type: 'string', enum: ['lactose_free', 'gluten_free', 'vegan', 'vegetarian'] } },
        exclude_allergens: { type: 'array', items: { type: 'string', enum: GS1 } },
        priorities: { type: 'string', enum: ['price_and_availability', 'sustainability', 'reliability_first'] },
        clarification: { type: 'string' },
      },
      required: ['items', 'deliver_by', 'diets', 'exclude_allergens', 'priorities', 'clarification'],
    },
  );
}

/** Recipe ingredient lines → what to buy (§ recipes). Run once when recipes are fetched, so a person can check the result. */
export async function normalizeIngredients(lines: string[]) {
  const r = await ask<{ ingredients: { need: string; skip: boolean; pantry: boolean }[] }>(
    'Each line is an ingredient of a Finnish professional-kitchen recipe. For each line, in the same order, give: '
    + 'need = the product to buy, as a short Finnish noun in base form as it appears in wholesaler product names '
    + '(täysjyväpastaa → täysjyväpasta, pieniä perunoita → peruna, valkosipulia, hienonnettuna → valkosipuli, '
    + 'Gold&Green® vegekuutioita → vegekuutio, Valio Eila® voita → voi, tyrnimarjoja → tyrnimarja). '
    + 'Leave out storage and form prefixes that product names rarely use: pakastemaissia → maissi, pakasteherneitä → herne, '
    + 'kasvisliemikuutiota → kasvisliemi, säilyketomaatteja → kuorittu tomaatti, sydänsalaattia → salaatti, pinsapohjia → pinsa. '
    + 'skip = true for tap water and ice. pantry = true only for basic seasonings any kitchen stocks: salt, pepper, '
    + 'frying oil, dried herbs and spices. Main ingredients are never pantry.',
    { lines },
    { type: 'object', properties: { ingredients: { type: 'array', items: { type: 'object', properties: {
      need: { type: 'string' }, skip: { type: 'boolean' }, pantry: { type: 'boolean' },
    }, required: ['need', 'skip', 'pantry'] } } }, required: ['ingredients'] },
  );
  return r && Array.isArray(r.ingredients) && r.ingredients.length === lines.length ? r.ingredients : null;
}
