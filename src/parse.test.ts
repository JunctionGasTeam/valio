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

test('day words end the product name', () => {
  assert.deepEqual(parseRequest('Tarvitsen 200 l laktoositonta maitoa huomenna').request.items, [{ need: 'maito', quantity: 200, unit: 'l' }]);
  assert.deepEqual(parseRequest('300 l milk monday').request.items, [{ need: 'milk', quantity: 300, unit: 'l' }]);
});

test('ambiguity asks instead of guessing', () => {
  assert.match(parseRequest('lots of milk please').clarification!, /How much/);
  assert.match(parseRequest('I need 20 kg by Friday').clarification!, /Which product/);
});

test('keyword detector finds limits in any phrasing', () => {
  assert.deepEqual(detectLimits('nut-free, no eggs, without soy, vegan'), { diets: ['vegan'], exclude_allergens: ['AE', 'AN', 'AY'] });
  assert.deepEqual(detectLimits('peanut butter for the kitchen'), { diets: [], exclude_allergens: [] });
});

test('allergy phrasing is a limit too', () => {
  assert.deepEqual(detectLimits('milk allergy in the group').exclude_allergens, ['AM']);
  assert.deepEqual(detectLimits('one guest is allergic to nuts').exclude_allergens, ['AN']);
  assert.deepEqual(detectLimits('maitoallergia ja pähkinäallergia').exclude_allergens, ['AM', 'AN']);
  assert.deepEqual(detectLimits('lactose-free milk').exclude_allergens, []);
});

test('read-back: quantities are checked against the text, assumptions are named', async () => {
  const { quantityInText, readBack } = await import('./parse.ts');
  assert.ok(quantityInText('I need 1,000 litres of milk', 1000));
  assert.ok(quantityInText('500 g butter', 0.5) && quantityInText('5 dl cream', 0.5));
  assert.ok(!quantityInText('I need 1,000 litres of milk', 100));
  const rb = readBack({
    source_text: '3 kilos of oat bread', items: [{ need: 'kauraleipä', quantity: 30, unit: 'kg' }],
    deliver_by: '2026-11-15', deliver_by_defaulted: true, diets: [], exclude_allergens: ['AM'], priorities: 'price_and_availability',
  })!;
  assert.deepEqual(rb.items, [{ quantity_in_text: false, words: 'oat bread' }]);
  assert.equal(rb.deliver_by, 'assumed');
  assert.deepEqual(rb.added_limits, ['AM']);
  assert.equal(readBack({ items: [], deliver_by: '', diets: [], exclude_allergens: [], priorities: 'sustainability' }), null);
});
