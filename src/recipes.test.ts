import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine, scaleRecipe, type Recipe } from './recipes.ts';

test('recipe line: "<number> kg <name>", preparation notes dropped', () => {
  assert.deepEqual(parseLine('0,900 kg täysjyväpastaa'), { kg: 0.9, name: 'täysjyväpastaa' });
  assert.deepEqual(parseLine('0,020 kg valkosipulia, hienonnettuna'), { kg: 0.02, name: 'valkosipulia' });
  assert.deepEqual(parseLine('0,180 kg vettä (n. 42°C)'), { kg: 0.18, name: 'vettä' });
  assert.equal(parseLine('2 dl kermaa'), null);
});

test('scaling: × portions/yield, up to 10 g, same ingredient merged, nothing-to-buy and pantry lines named', () => {
  const r: Recipe = { id: '1', name: 'Test', url: '', image: null, yield: 18, course: 'Main course', diets: [], lines: [
    { text: '0,900 kg täysjyväpastaa', kg: 0.9, need: 'täysjyväpasta', pantry: false, product: null },
    { text: '0,500 kg pakastemaissia', kg: 0.5, need: 'maissi', pantry: false, product: null },
    { text: '1,000 kg pakastemaissia', kg: 1, need: 'maissi', pantry: false, product: null },
    { text: '2,250 kg kylmää vettä', kg: 2.25, need: null, pantry: false, product: null },
    { text: '0,007 kg suolaa', kg: 0.007, need: 'suola', pantry: true, product: null },
    { text: '0 kg mustapippuria, maun mukaan', kg: 0, need: 'mustapippuri', pantry: true, product: null },
  ] };
  const s = scaleRecipe(r, 120);
  assert.deepEqual(s.items.map((i) => [i.need, i.quantity]), [['täysjyväpasta', 6], ['maissi', 10]]);
  assert.equal(s.items[1].from, '0,500 kg pakastemaissia + 1,000 kg pakastemaissia × 120/18 portions = 10 kg');
  assert.deepEqual(s.skipped.map((x) => x.reason), ['nothing to buy', 'usually in stock', 'to taste']);
  assert.deepEqual(scaleRecipe(r, 120, ['suola']).items.map((i) => [i.need, i.quantity]).at(-1), ['suola', 0.05]); // 0.0467 → 0.05
});
