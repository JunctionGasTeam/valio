import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest, detectLimits } from './parse.ts';

process.env.DEMO_NOW = '2026-11-14T12:00:00+0200'; // Saturday

test('the brief\'s own sentence', () => {
  const { request: r, clarification } = parseRequest('I need 1,000 litres of lactose-free milk by Monday, best on price and availability.');
  assert.equal(clarification, null);
  assert.deepEqual(r.items, [{ need: 'milk', quantity: 1000, unit: 'l' }]);
  assert.equal(r.deliver_by, '2026-11-16');
  assert.deepEqual(r.diets, ['lactose_free']);
  assert.equal(r.priorities, 'price_and_availability');
});

test('Finnish, several items, explicit date, allergens', () => {
  const { request: r } = parseRequest('Tarvitsen 1.000 l laktoositonta maitoa ja 25 kg gluteenittomia jauhoja 18.11. pähkinätön');
  assert.deepEqual(r.items, [{ need: 'maito', quantity: 1000, unit: 'l' }, { need: 'jauho', quantity: 25, unit: 'kg' }]);
  assert.equal(r.deliver_by, '2026-11-18');
  assert.deepEqual(r.diets, ['lactose_free', 'gluten_free']);
  assert.deepEqual(r.exclude_allergens, ['AN']);
});

test('ambiguity asks instead of guessing', () => {
  assert.match(parseRequest('lots of milk please').clarification!, /How much/);
  assert.match(parseRequest('I need 20 kg by Friday').clarification!, /Which product/);
});

test('keyword detector finds limits in any phrasing', () => {
  assert.deepEqual(detectLimits('nut-free, no eggs, without soy, vegan'), { diets: ['vegan'], exclude_allergens: ['AE', 'AN', 'AY'] });
  assert.deepEqual(detectLimits('peanut butter for the kitchen'), { diets: [], exclude_allergens: [] });
});
