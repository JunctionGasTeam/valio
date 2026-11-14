// Demo fixture (context.md §11.3): wipes proposals and the decision record, keeps the catalogue and the recorded offer
// cache, then adds five small milk orders approved unchanged "in earlier weeks", so the trust-ladder suggestion (§8.4)
// is there for the closing line. Demo data only: a real deployment never drops the audit table.
import { openDb } from './db.ts';
import { createApp, seed } from './api.ts';

process.env.DEMO_NOW ??= '2026-11-14T12:00:00+0200';
let db = openDb();
seed(db);
db.exec(`DROP TABLE audit; DROP TABLE proposals; UPDATE customers SET policy = NULL, agents_enabled = 1;
         UPDATE tokens SET limits = NULL, revoked = 0;`);
db.close();
db = openDb(); // recreates the empty tables and the append-only triggers
const app = createApp(db);
const call = async (token: string, path: string, body: unknown) => {
  const res = await app.request(path, { method: 'POST', body: JSON.stringify(body), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
  const j = (await res.json()) as any;
  if (!res.ok) throw new Error(`${path}: ${res.status} ${j.error}`);
  return j;
};
for (const litres of [150, 200, 180, 220, 200]) {
  const p = await call('demo-agent', '/proposals', {
    site: 'Hotel Kaisla Helsinki', deliver_by: '2026-11-16', items: [{ need: 'maito', quantity: litres, unit: 'l' }], diets: ['lactose_free'],
    source_text: `${litres} l lactose-free milk by Monday`,
  });
  // The kitchen takes the sure-delivery option each week (the agent's own offer: not a fix, so trust still grows).
  await app.request(`/proposals/${p.id}`, { method: 'PATCH', body: JSON.stringify({ item: 0, confirmed_only: true }), headers: { authorization: 'Bearer demo-owner', 'content-type': 'application/json' } });
  await call('demo-owner', `/proposals/${p.id}/confirm`, {}); // "this is what I meant"
  await call('demo-owner', `/proposals/${p.id}/decision`, { decision: 'approve', note: 'routine weekly order' });
  const done = (await (await app.request(`/proposals/${p.id}`, { headers: { authorization: 'Bearer demo-owner' } })).json()) as any;
  console.log(`history: ${litres} l, sure delivery ${done.items[0].allocation.map((l: any) => l.id).join('+')}, €${done.total_cents / 100}, approved`);
}
const trust = await (await app.request('/trust', { headers: { authorization: 'Bearer demo-owner' } })).json() as any;
console.log('trust ladder:', trust.suggestion?.text ?? `streak ${trust.streak}, no suggestion`);
