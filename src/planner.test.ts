// Golden test needs data/valio.db with the milk offers for 2026-11-16 recorded in offer_cache (one online planner run).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.ts';
import { getProduct, ineligibility } from './catalogue.ts';
import { allocate, planItem, unitsFor } from './planner.ts';

test('lot size: 0.01 counts as 1, other lots round up to their multiple', () => {
  assert.equal(unitsFor(1000, 1, 0.01), 1000);
  assert.equal(unitsFor(10, 3, 0.01), 4);
  assert.equal(unitsFor(2, 1, 1.5), 3);
  assert.equal(unitsFor(1000, 0.5, 0.01), 2000);
});

test('allocation: split never exceeds known amounts, at most 3 products, late options last, shortfall stated', () => {
  const o = (available: number | null, late = false, lot = 0.01) => ({ content: 1, lot, available, late });
  const a = allocate(1000, [o(384), o(51), o(null, true), o(9999)]);
  assert.deepEqual(a.parts.map((p) => p.units), [384, 51, 565]);
  assert.equal(a.parts[2].option.available, 9999); // on-time option before the late one
  assert.equal(a.shortfall, 0);

  const b = allocate(1000, [o(10), o(20), o(30), o(40)]);
  assert.equal(b.parts.length, 3);
  assert.equal(b.shortfall, 940);
  for (const p of [...a.parts, ...b.parts]) if (p.option.available !== null) assert.ok(p.units <= p.option.available);

  assert.deepEqual(allocate(10, [o(5, false, 2)]).parts.map((p) => p.units), [4]); // lot 2, only 5 known → 4
});

test('golden: 1,000 l lactose-free milk on cached offers', async () => {
  process.env.DEMO_NOW = '2026-11-14T12:00:00+0200';
  const db = openDb();
  const f = mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  const limits = { diets: ['lactose_free' as const] };
  const r = await planItem(db, { need: 'maito', quantity: 1000, unit: 'l' }, limits, '2026-11-16');
  f.mock.restore();

  assert.equal(r.category, '10400');
  assert.ok(!r.dropped.some((d) => d.reasons.some((x) => x.includes('E9'))), 'cache not recorded: run the planner online once');
  for (const e of ['E2', 'E5', 'E6']) assert.ok(r.exceptions.includes(e), e);
  assert.deepEqual(r.options.slice(0, 3).map((o) => o.id), ['464306', '464401', '464237']);
  for (const o of r.options) assert.deepEqual(ineligibility(o.product, limits), []);

  assert.equal(r.allocation.length, 1);
  assert.deepEqual(
    { id: r.allocation[0].id, units: r.allocation[0].sales_units, cost: r.allocation[0].cost_cents, flags: r.allocation[0].flags },
    { id: '464306', units: 1000, cost: 101000, flags: ['E5'] },
  );

  const e2 = r.dropped.find((d) => d.id === '464440')!;
  assert.ok(e2.reasons[0].includes('E2'));
  const orig = getProduct(db, '464440')!;
  for (const s of e2.substitutes) {
    const p = getProduct(db, s)!;
    assert.ok([...p.contains, ...p.may_contain].every((a) => orig.contains.includes(a) || orig.may_contain.includes(a)));
  }
});
