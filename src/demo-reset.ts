// Demo fixture (context.md §11.3): wipes proposals, the decision record and registered accounts, keeps the catalogue and the recorded offer
// cache, then adds two small milk orders approved unchanged "in earlier weeks", so the third approval, made live,
// brings up the trust-ladder suggestion (§8.4). Demo data only: a real deployment never drops the audit table.
import { openDb } from './db.ts';
import { createApp, seed, seedHistory } from './api.ts';

process.env.DEMO_NOW ??= '2026-11-14T12:00:00+0200';
let db = openDb();
seed(db);
// Registered accounts go too (their kitchens, sessions, agent keys): only the demo kitchen is left.
db.exec(`DROP TABLE audit; DROP TABLE proposals;
         DELETE FROM users; DELETE FROM tokens WHERE customer != 'kaisla'; DELETE FROM customers WHERE id != 'kaisla';
         UPDATE customers SET policy = NULL, agents_enabled = 1; UPDATE tokens SET limits = NULL, revoked = 0;`);
db.close();
db = openDb(); // recreates the empty tables and the append-only triggers
const app = createApp(db);
for (const p of await seedHistory(app, 'demo-owner', 'demo-agent'))
  console.log(`history: ${p.request.items[0].quantity} l, sure delivery ${p.items[0].allocation.map((l: any) => l.id).join('+')}, €${p.total_cents / 100}, approved`);
const trust = await (await app.request('/trust', { headers: { authorization: 'Bearer demo-owner' } })).json() as any;
console.log('trust ladder:', trust.suggestion?.text ?? `streak ${trust.streak}, no suggestion`);
