// Needs data/valio.db (`npm run db`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.ts';
import { search, ineligibility, getProduct } from './catalogue.ts';

const db = openDb();

test('lactose-free milk search finds the demo products, fast, and nothing ineligible', () => {
  const t = performance.now();
  const { category, matches, excluded } = search(db, 'maito', { diets: ['lactose_free'] });
  assert.ok(performance.now() - t < 100);
  assert.equal(category, '10400');
  const ids = matches.map((p) => p.id);
  for (const id of ['464306', '464401']) assert.ok(ids.includes(id), id);
  for (const p of matches) assert.deepEqual(ineligibility(p, { diets: ['lactose_free'] }), []);
  assert.ok(excluded.length > 0);
});

test('all terms beat any term: coconut milk is not cow milk', () => {
  const { category, matches } = search(db, 'coconut milk');
  assert.notEqual(category, '10400');
  assert.ok(matches[0].name_en!.toLowerCase().includes('coconut'));
});

test('missing allergen data excludes whenever a limit applies, never otherwise', () => {
  const p = { ...getProduct(db, '464306')!, has_allergen_statement: false };
  assert.deepEqual(ineligibility(p, {}), []);
  assert.ok(ineligibility(p, { exclude_allergens: ['AE'] }).includes('allergen data missing'));
});

test('MAY_CONTAIN counts as excluded', () => {
  const p = { ...getProduct(db, '464306')!, contains: [], may_contain: ['AN'] };
  assert.deepEqual(ineligibility(p, { exclude_allergens: ['AN'] }), ['may contain allergen AN']);
});

test('user text cannot break the FTS query', () => {
  assert.doesNotThrow(() => search(db, 'milk" OR NEAR(x) *'));
});

test('only name matches: a category neighbour never stands in for what was asked', () => {
  const { matches } = search(db, 'kauraleipä', {}, 200);
  assert.ok(matches.length > 0);
  for (const p of matches) assert.match(`${p.name_fi} ${p.name_en} ${p.name_sv}`.toLowerCase(), /kauraleipä/);
  assert.ok(!matches.some((p) => p.id === '466005'), 'Pågen wheat toast is not oat bread');
});

test('milk allergy also excludes products that list only lactose', () => {
  const goat = getProduct(db, '473013')!; // Soignon goat cheese: data lists ML, not AM
  assert.deepEqual(goat.contains, ['ML']);
  assert.deepEqual(ineligibility(goat, { exclude_allergens: ['AM'] }), ['contains allergen AM']);
});

test('a short word inside other words does not pick the category: voi is butter, not voileipä biscuits', () => {
  const r = search(db, 'voi');
  assert.equal(r.category, '10500');
  assert.ok(r.matches.slice(0, 10).some((p) => p.id === '463798')); // Valio voi 200 g
});
