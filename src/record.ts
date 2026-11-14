// Records the offers the demo scenes use into offer_cache (context.md §11.3). Run online the day before: `npm run record`.
// During the demo, if the API is down or slow, the gateway serves these and says "cached offers used".
import { openDb } from './db.ts';
import { planItem } from './planner.ts';

const DATE = process.env.DEMO_DATE ?? '2026-11-16';
const db = openDb();
// 'maito' (form, Finnish), 'milk' (the brief's sentence through the parser), 'lactose free milk' (an agent's wording)
for (const need of ['maito', 'milk', 'lactose free milk']) {
  const r = await planItem(db, { need, quantity: 1000, unit: 'l' }, { diets: ['lactose_free'] }, DATE);
  console.log(`${need}: ${r.options.length} deliverable, ${r.dropped.length} dropped, best ${r.allocation[0]?.id ?? '-'}, exceptions ${r.exceptions.join(',')}`);
  if (r.errors.length) { console.error('  NOT RECORDED:', r.errors.join('; ')); process.exitCode = 1; }
}
const n = db.prepare('SELECT count(*) n, min(fetched_at) oldest FROM offer_cache WHERE date = ?').get(DATE) as any;
console.log(`offer_cache for ${DATE}: ${n.n} responses, oldest ${n.oldest}`);
