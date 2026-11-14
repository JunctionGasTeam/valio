import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.ts';
import { checkOffers } from './offers.ts';

process.env.DEMO_NOW = '2026-11-14T12:00:00+0200';
const db = openDb(':memory:');
const DATE = '2026-11-16';
const line = (amount: number, date = DATE, salesBlock = false) => [{ salesBlock, availableAmount: amount, availableDate: date, salesUnit: 'ST' }];
const AVAIL = [
  { productId: 'ok', closingTime: '2026-11-15T17:00:00+0200', salesBlock: false, logisticModel: 'Stock', scheduleLines: line(384) },
  { productId: 'unknown', closingTime: '2026-11-15T17:00:00+0200', salesBlock: false, logisticModel: 'Stock', scheduleLines: line(9999999999) },
  { productId: 'late', closingTime: '2026-11-15T17:00:00+0200', salesBlock: false, logisticModel: 'Stock', scheduleLines: line(10, '2026-11-18') },
  { productId: 'cutoff', closingTime: '2026-11-12T10:00:00+0200', salesBlock: false, logisticModel: 'Terminal', scheduleLines: line(999999) },
  { productId: 'gone', salesBlock: false, scheduleLines: [] },
];
const price = (id: string) => id === 'cutoff'
  ? { productId: id, quantity: 1, error: true, netPriceFound: false }
  : { productId: id, quantity: 1, error: false, netPriceFound: true, comparisonUnit: 'L', tax: { taxRate: 13.5, taxValue: 0.14 },
      catalogPrice: { value: 1.01, validTo: '2026-12-31T00:00:00+0200' }, comparisonPrice: { value: 1.01 } };
const IDS = AVAIL.map((a) => a.productId);
const reply = (status: number, url: string) =>
  new Response(JSON.stringify({ products: url.endsWith('/price') ? IDS.map(price) : AVAIL }), { status });

test('maps responses to offers with exception codes', async () => {
  const f = mock.method(globalThis, 'fetch', async (url: string) => reply(200, url));
  const { errors, offers } = await checkOffers(db, IDS, DATE);
  f.mock.restore();
  assert.deepEqual(errors, []);
  const by = Object.fromEntries(offers.map((o) => [o.id, o]));
  assert.deepEqual(by.ok.exceptions, []);
  assert.equal(by.ok.price_cents, 101);
  assert.equal(by.ok.available_amount, 384);
  assert.deepEqual(by.unknown.exceptions, ['E5']);
  assert.equal(by.unknown.available_amount, null);
  assert.deepEqual(by.late.exceptions, ['E3']);
  assert.deepEqual(by.cutoff.exceptions.sort(), ['E5', 'E6', 'E7']);
  assert.deepEqual(by.gone.exceptions, ['E2']);
});

test('429 waits 30 s and retries once', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const f = mock.method(globalThis, 'fetch', async (url: string) => reply(++calls === 1 ? 429 : 200, url));
  const p = checkOffers(db, IDS, DATE);
  while (calls < 2) { await new Promise((r) => setImmediate(r)); mock.timers.tick(30_000); }
  const { errors, offers } = await p;
  f.mock.restore(); mock.timers.reset();
  assert.deepEqual(errors, []);
  assert.equal(calls, 3); // price: 429 + retry, availability: 1
  assert.equal(offers[0].from_cache, false);
});

test('API down → cached responses, flagged, with fetch time', async () => {
  const f = mock.method(globalThis, 'fetch', async (url: string) => reply(500, url));
  const { errors, offers } = await checkOffers(db, IDS, DATE);
  f.mock.restore();
  assert.equal(errors.length, 2);
  assert.ok(offers.every((o) => o.from_cache && o.fetched_at));
  assert.deepEqual(offers[0].exceptions, []);
  const cold = await (async () => {
    const g = mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
    try { return await checkOffers(db, ['never-seen'], DATE); } finally { g.mock.restore(); }
  })();
  assert.deepEqual(cold.offers[0].exceptions, ['E9']);
});

test('rejects oversized or malformed calls before touching the API', async () => {
  await assert.rejects(checkOffers(db, Array(51).fill('x'), DATE), RangeError);
  await assert.rejects(checkOffers(db, ['x'], '16.11.2026'), RangeError);
});
