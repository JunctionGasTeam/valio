// Approval UI (context.md §11.2 scenes 2–5): proposals, reasons, alternatives, decision, policy, decision record.
import { StrictMode, useCallback, useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';

// ponytail: role switcher over demo tokens; real login when this leaves the demo.
const USERS: Record<string, string> = { 'demo-approver': 'Purchasing manager (approver)', 'demo-requester': 'Chef (requester)' };
const EXC: Record<string, [string, 'bad' | 'warn']> = {
  E1: ['No match', 'bad'], E2: ['Not deliverable', 'warn'], E3: ['Late', 'warn'], E4: ['Split / partial', 'warn'],
  E5: ['Amount not confirmed', 'warn'], E6: ['Cut-off passed', 'warn'], E7: ['No price', 'warn'], E8: ['Allergen data missing', 'warn'],
  E9: ['API trouble, cached', 'bad'], content_from_price: ['Pack size from price', 'warn'], content_mismatch: ['Pack size corrected', 'warn'],
};
const STATUS: Record<string, 'ok' | 'bad' | 'warn' | ''> = { needs_review: 'warn', auto_approved: 'ok', approved: 'ok', rejected: 'bad', expired: 'bad', exported: '' };
const eur = (c: number | null | undefined) => (c == null ? '–' : (c / 100).toLocaleString('en-IE', { style: 'currency', currency: 'EUR' }));
const time = (s: string) => new Date(s).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'medium' });

class ApiError extends Error { constructor(message: string, public body: any) { super(message); } }
async function api(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`/api${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(j.error ?? res.statusText, j);
  return j;
}

async function download(token: string, id: string) {
  const res = await fetch(`/api/proposals/${id}/export`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new ApiError((await res.json().catch(() => ({}))).error ?? res.statusText, null);
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(await res.blob()), download: res.headers.get('content-disposition')?.match(/filename="(.+)"/)?.[1] ?? 'order.csv',
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

const useHash = () => {
  const [h, set] = useState(location.hash);
  useEffect(() => { const f = () => set(location.hash); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  return h;
};
const Chip = ({ code }: { code: string }) => <span className={`chip ${EXC[code]?.[1] ?? ''}`} title={code}>{EXC[code]?.[0] ?? code}</span>;

function App() {
  const [token, setToken] = useState(() => { try { return localStorage.getItem('token') ?? 'demo-approver'; } catch { return 'demo-approver'; } });
  const hash = useHash();
  const pick = (t: string) => { setToken(t); try { localStorage.setItem('token', t); } catch { /* private mode */ } };
  const id = hash.match(/^#\/p\/(.+)$/)?.[1];
  return (
    <>
      <header>
        <strong>Trusted Trade Agents</strong>
        <nav><a href="#">Proposals</a><a href="#/new">New request</a><a href="#/policy">Policy</a></nav>
        <label>Signed in as
          <select value={token} onChange={(e) => pick(e.target.value)}>
            {Object.entries(USERS).map(([t, n]) => <option key={t} value={t}>{n}</option>)}
          </select>
        </label>
      </header>
      <main>
        {token === 'demo-approver' && <TrustBanner key={hash} token={token} />}
        {id ? <Proposal key={id + token} id={id} token={token} />
          : hash === '#/new' ? <NewRequest token={token} />
          : hash.startsWith('#/policy') ? <Policy key={hash + token} token={token} suggest={hash.endsWith('?suggest')} />
          : <List token={token} />}
      </main>
    </>
  );
}

// §8.4: a suggestion only; the approver reviews the values and saves the policy themselves.
function TrustBanner({ token }: { token: string }) {
  const [t, setT] = useState<any>(null);
  useEffect(() => { api(token, 'GET', '/trust').then(setT, () => setT(null)); }, [token]);
  if (!t?.suggestion || location.hash.startsWith('#/policy')) return null;
  return (
    <div className="alert ok row">
      <span className="grow">{t.suggestion.text}</span>
      <a href="#/policy?suggest"><button>Review suggested policy</button></a>
    </div>
  );
}

function List({ token }: { token: string }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    const load = () => api(token, 'GET', '/proposals').then(setRows, (e) => setErr(e.message));
    load();
    const t = setInterval(load, 5000); // proposals made by agents over MCP appear on their own
    return () => clearInterval(t);
  }, [token]);
  if (err) return <div className="alert bad">{err}</div>;
  if (!rows) return <p className="muted">Loading…</p>;
  return (
    <div className="card">
      <h2>Proposals</h2>
      {!rows.length ? <p className="muted">No proposals yet. Ask an agent, or <a href="#/new">make a request</a>.</p> : (
        <div className="scroll"><table>
          <thead><tr><th>Created</th><th>Need</th><th>Site</th><th>Deliver by</th><th>Status</th><th className="num">Total</th><th>By</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id}>
              <td><a href={`#/p/${r.id}`}>{time(r.created_at)}</a></td><td>{r.needs.join(', ')}</td><td>{r.site}</td><td>{r.deliver_by}</td>
              <td><span className={`chip ${STATUS[r.status]}`}>{r.status.replace('_', ' ')}</span></td>
              <td className="num">{eur(r.total_cents)}</td><td className="muted">{r.created_by}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}

function Proposal({ id, token }: { id: string; token: string }) {
  const [p, setP] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [diffs, setDiffs] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => Promise.all([api(token, 'GET', `/proposals/${id}`), api(token, 'GET', `/audit?proposal=${id}`)])
    .then(([p, e]) => { setP(p); setEvents(e); }, (e) => setErr(e.message)), [id, token]);
  useEffect(() => { load(); }, [load]);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(''); setDiffs(null);
    try { await fn(); } catch (e) { setErr((e as Error).message); setDiffs((e as ApiError).body?.diffs ?? null); }
    await load(); setBusy(false);
  };
  const revise = (item: number, rev: object) => act(() => api(token, 'PATCH', `/proposals/${id}`, { item, ...rev }));
  const decide = (decision: string) => act(() => api(token, 'POST', `/proposals/${id}/decision`, { decision }));

  if (!p) return err ? <div className="alert bad">{err}</div> : <p className="muted">Loading…</p>;
  const open = ['needs_review', 'auto_approved'].includes(p.status);
  const approver = token === 'demo-approver';
  const failed = p.policy_verdict.rules.filter((r: any) => !r.ok);
  return (
    <>
      <div className="card">
        <div className="row">
          <div className="grow">
            <h1>{p.site}</h1>
            <div className="muted">Deliver by {p.deliver_by}{p.deliver_by_defaulted && ' (no date given: next delivery day)'} · by {p.created_by} · {time(p.created_at)}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <span className={`chip ${STATUS[p.status]}`}>{p.status.replace('_', ' ')}</span>
            <div style={{ fontSize: 20, fontWeight: 600 }}>{eur(p.total_cents)}</div>
            <div className="muted">ex. VAT</div>
          </div>
        </div>
        <p>{p.next}</p>
        {['approved', 'auto_approved', 'exported'].includes(p.status) && (
          <div className="row" style={{ marginBottom: 8 }}>
            <button className="primary" disabled={busy} onClick={() => act(() => download(token, id))}>Download webshop import file</button>
            <span className="muted">CSV by GTIN, one row per line. Import it into the cart for its delivery date.</span>
          </div>
        )}
        {open && (approver ? (
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => decide('approve')}>Approve</button>
            <button className="danger" disabled={busy} onClick={() => decide('reject')}>Reject</button>
            <span className="muted">Prices and availability are re-checked before approval.</span>
          </div>
        ) : <p className="muted">Only an approver can approve or reject.</p>)}
      </div>

      {err && <div className="alert bad">{err}</div>}
      {diffs && (
        <div className="alert warn"><strong>Changed since the proposal was made:</strong>
          <ul>{diffs.map((d, i) => <li key={i}>{d.id}: {d.what} {String(d.before)} → {String(d.after)}</li>)}</ul>
          Review the lines and approve again.
        </div>
      )}

      <div className="card">
        <h2>Policy check {failed.length ? <span className="chip warn">{failed.length} need a human</span> : <span className="chip ok">all passed</span>}</h2>
        {[...failed, ...p.policy_verdict.rules.filter((r: any) => r.ok)].map((r: any) => (
          <div key={r.rule} className="rule">
            <span className={`chip ${r.ok ? 'ok' : 'bad'}`}>{r.ok ? 'pass' : 'human'}</span>
            <span>{r.detail}</span>
            {r.hard && <span className="chip" title="No setting changes this rule">hard rule</span>}
          </div>
        ))}
      </div>

      {p.items.map((it: any, i: number) => <Item key={i} it={it} open={open} busy={busy} revise={(rev) => revise(i, rev)} />)}

      <div className="card">
        <h2>Decision record</h2>
        {events.map((e) => (
          <details key={e.seq}>
            <summary>{time(e.at)} · <strong>{e.event.replace('_', ' ')}</strong> · {e.actor}</summary>
            <pre>{JSON.stringify(e.data, null, 2)}</pre>
          </details>
        ))}
      </div>
    </>
  );
}

function Item({ it, open, busy, revise }: { it: any; open: boolean; busy: boolean; revise: (rev: object) => void }) {
  const [qty, setQty] = useState(it.item.quantity);
  const unit = it.item.unit === 'pcs' ? 'unit' : it.item.unit;
  const chosen = new Set(it.allocation.map((a: any) => a.id));
  return (
    <div className="card">
      <div className="row">
        <h2 className="grow">{it.item.quantity} {it.item.unit} · {it.item.need}</h2>
        {it.exceptions.map((e: string) => <Chip key={e} code={e} />)}
      </div>
      {it.errors.map((e: string) => <div key={e} className="alert bad">{e}</div>)}
      {it.shortfall > 0 && <div className="alert warn">{+it.shortfall.toFixed(3)} {unit} of {it.item.quantity} not covered.</div>}

      <h3>Order lines</h3>
      {!it.allocation.length ? <p className="muted">No line could be planned.</p> : (
        <div className="scroll"><table>
          <thead><tr><th>Product</th><th className="num">Qty</th><th className="num">Cost</th><th>Delivers</th><th>Why</th></tr></thead>
          <tbody>{it.allocation.map((a: any) => (
            <tr key={a.id}>
              <td>{a.name}<div className="muted">{a.id} {a.flags.map((f: string) => <Chip key={f} code={f} />)}</div></td>
              <td className="num">{a.sales_units} {a.sales_unit}</td><td className="num">{eur(a.cost_cents)}</td><td>{a.date}</td>
              <td className="muted">{a.reason}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}

      {open && (
        <div className="row" style={{ marginTop: 10 }}>
          <button disabled={busy} onClick={() => revise({ confirmed_only: true })}>Confirmed stock only</button>
          <button disabled={busy} onClick={() => revise({})}>Best overall</button>
          <label>Quantity <input type="number" min={0} step="any" value={qty} onChange={(e) => setQty(+e.target.value)} style={{ width: 100 }} /> {unit}</label>
          <button disabled={busy || !(qty > 0) || qty === it.item.quantity} onClick={() => revise({ quantity: qty })}>Set</button>
        </div>
      )}

      <h3>Alternatives ({it.options.length} deliverable)</h3>
      <div className="scroll"><table>
        <thead><tr><th>Product</th><th className="num">Price / {unit}</th><th className="num">Available</th><th className="num">Score</th><th /></tr></thead>
        <tbody>{it.options.map((o: any) => (
          <tr key={o.id}>
            <td>{o.name}<div className="muted">{o.id} {o.late && <Chip code="E3" />} {o.content_flag && <Chip code={o.content_flag} />}</div></td>
            <td className="num">{eur(o.unit_price_cents)}</td>
            <td className="num">{o.available === null ? <Chip code="E5" /> : `${o.available} ${o.offer.sales_unit}`}</td>
            <td className="num" title={Object.entries(o.criteria).map(([k, v]) => `${k} ${(v as number).toFixed(2)}`).join(', ')}>{o.score.toFixed(2)}</td>
            <td className="num">{chosen.has(o.id) ? <span className="chip ok">in order</span>
              : open && <button disabled={busy} onClick={() => revise({ choose: o.id })}>Choose</button>}</td>
          </tr>
        ))}</tbody>
      </table></div>

      {!!it.dropped.length && (
        <details><summary>{it.dropped.length} not deliverable or not priced</summary>
          <table><tbody>{it.dropped.map((d: any) => (
            <tr key={d.id}><td>{d.name}<div className="muted">{d.id}</div></td><td>{d.reasons.join('; ')}</td>
              <td className="muted">{d.substitutes.length ? `substitutes: ${d.substitutes.join(', ')}` : ''}</td></tr>
          ))}</tbody></table>
        </details>
      )}
      {!!it.excluded_total && (
        <details><summary>{it.excluded_total} excluded by your limits{it.excluded_total > it.excluded.length && ` (first ${it.excluded.length} shown, all in the decision record)`}</summary>
          <table><tbody>{it.excluded.map((d: any) => <tr key={d.id}><td>{d.name}<div className="muted">{d.id}</div></td><td>{d.reasons.join('; ')}</td></tr>)}</tbody></table>
        </details>
      )}
    </div>
  );
}

function NewRequest({ token }: { token: string }) {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const list = (k: string) => String(f.get(k) ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    setBusy(true); setErr('');
    try {
      const p = await api(token, 'POST', '/proposals', {
        site: f.get('site'), deliver_by: f.get('deliver_by') || undefined, priorities: f.get('priorities'),
        items: [{ need: f.get('need'), quantity: Number(f.get('quantity')), unit: f.get('unit') }],
        diets: f.getAll('diets'), exclude_allergens: list('allergens'),
      });
      location.hash = `#/p/${p.id}`;
    } catch (e) { setErr((e as ApiError).body?.question ?? (e as Error).message); setBusy(false); }
  };
  const fromText = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setErr('');
    try {
      const { request, clarification } = await api(token, 'POST', '/parse', { text: f.get('text') });
      if (clarification) { setErr(clarification); setBusy(false); return; }
      const p = await api(token, 'POST', '/proposals', { site: f.get('site'), ...request });
      location.hash = `#/p/${p.id}`;
    } catch (e) { setErr((e as ApiError).body?.question ?? (e as Error).message); setBusy(false); }
  };
  return (
    <>
    <form className="card" onSubmit={fromText} style={{ maxWidth: 520 }}>
      <h2>Describe what you need</h2>
      <input type="hidden" name="site" value="Hotel Kaisla Helsinki" />
      <div className="field"><label htmlFor="text">In your own words (English, Finnish or Swedish)</label>
        <textarea id="text" name="text" rows={3} required style={{ font: 'inherit', padding: 8, borderRadius: 6, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--fg)' }}
          defaultValue="I need 1,000 litres of lactose-free milk by Monday, best on price and availability." />
      </div>
      <button className="primary" disabled={busy}>{busy ? 'Planning…' : 'Plan it'}</button>
    </form>
    <form className="card" onSubmit={submit} style={{ maxWidth: 520 }}>
      <h2>Or fill in the form</h2>
      <div className="field"><label htmlFor="site">Site</label><input id="site" name="site" required defaultValue="Hotel Kaisla Helsinki" /></div>
      <div className="row">
        <div className="field grow"><label htmlFor="need">Need</label><input id="need" name="need" required defaultValue="maito" /></div>
        <div className="field"><label htmlFor="quantity">Quantity</label><input id="quantity" name="quantity" type="number" min="0.001" step="any" required defaultValue={1000} style={{ width: 110 }} /></div>
        <div className="field"><label htmlFor="unit">Unit</label><select id="unit" name="unit" defaultValue="l"><option>l</option><option>kg</option><option>pcs</option></select></div>
      </div>
      <div className="field"><label htmlFor="deliver_by">Deliver by (empty = next delivery day)</label><input id="deliver_by" name="deliver_by" type="date" defaultValue="2026-11-16" /></div>
      <fieldset className="field" style={{ border: 0, padding: 0 }}><legend>Diets</legend>
        <div className="row">{['lactose_free', 'gluten_free', 'vegan', 'vegetarian'].map((d) => (
          <label key={d}><input type="checkbox" name="diets" value={d} defaultChecked={d === 'lactose_free'} />{d.replace('_', '-')}</label>
        ))}</div>
      </fieldset>
      <div className="field"><label htmlFor="allergens">Exclude allergens (GS1 codes, comma separated: AM milk, AW gluten, AE egg, AN tree nuts…)</label><input id="allergens" name="allergens" /></div>
      <div className="field"><label htmlFor="priorities">Priorities</label>
        <select id="priorities" name="priorities"><option value="price_and_availability">Price and availability</option><option value="sustainability">Sustainability</option><option value="reliability_first">Reliability first</option></select>
      </div>
      <button className="primary" disabled={busy}>{busy ? 'Planning…' : 'Create proposal'}</button>
    </form>
    {err && <div className="alert warn" style={{ maxWidth: 520 }}>{err}</div>}
    </>
  );
}

function Policy({ token, suggest }: { token: string; suggest: boolean }) {
  const [pol, setPol] = useState<any>(null);
  const [msg, setMsg] = useState<[string, string] | null>(null);
  useEffect(() => {
    Promise.all([api(token, 'GET', '/policy'), suggest ? api(token, 'GET', '/trust') : null]).then(([p, t]) => {
      setPol(t?.suggestion?.policy ?? p);
      if (t?.suggestion) setMsg(['warn', 'Suggested values loaded from your approval history. Nothing changes until you save.']);
    }, (e) => setMsg(['bad', e.message]));
  }, [token, suggest]);
  if (!pol) return msg ? <div className="alert bad">{msg[1]}</div> : <p className="muted">Loading…</p>;
  const approver = token === 'demo-approver';
  const set = (k: string, v: unknown) => setPol({ ...pol, [k]: v });
  const bool = (k: string, text: string) => <label className="field" style={{ flexDirection: 'row' }}><input type="checkbox" disabled={!approver} checked={pol[k]} onChange={(e) => set(k, e.target.checked)} />{text}</label>;
  const num = (k: string, text: string) => <div className="field"><label htmlFor={k}>{text}</label><input id={k} type="number" min={0} disabled={!approver} value={pol[k]} onChange={(e) => set(k, +e.target.value)} style={{ width: 140 }} /></div>;
  const save = () => api(token, 'PUT', '/policy', pol).then((p) => { setPol(p); setMsg(['ok', 'Saved. Applies to new proposals and revisions.']); }, (e) => setMsg(['bad', e.message]));
  return (
    <div className="card" style={{ maxWidth: 560 }}>
      <h2>Customer policy</h2>
      <p className="muted">When every rule passes, an agent may finalise an order without a human. Hard rules (allergens, alcohol, late or uncovered lines, cached prices) always need a human. Agent keys can only be stricter.</p>
      {bool('agent_may_finalise', 'Agent may finalise orders (off = a human signs off every order)')}
      {num('max_order_eur', 'Max order without a human (€)')}
      {num('max_line_eur', 'Max line without a human (€)')}
      {bool('allow_unknown_amount', 'Allow lines whose available amount is not confirmed')}
      {bool('allow_split', 'Allow splitting an item across products')}
      {num('max_over_best_price_pct', 'Max % over the best price per unit')}
      {msg && <div className={`alert ${msg[0]}`}>{msg[1]}</div>}
      {approver ? <button className="primary" onClick={save}>Save policy</button> : <p className="muted">Only an approver can change the policy.</p>}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
