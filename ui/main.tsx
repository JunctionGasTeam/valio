// Approval UI (context.md §11.2 scenes 2–5): proposals, reasons, alternatives, decision, policy, decision record.
import { StrictMode, useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral';

// ponytail: role switcher over demo tokens; real login when this leaves the demo.
const USERS = [
  { token: 'demo-approver', name: 'Purchasing manager', role: 'Approver' },
  { token: 'demo-requester', name: 'Chef', role: 'Requester' },
];
const EXC: Record<string, { label: string; tone: Tone; help: string }> = {
  E1: { label: 'No match', tone: 'bad', help: 'No product passed the filters for this need.' },
  E2: { label: 'Some not deliverable', tone: 'neutral', help: 'Some products cannot be delivered. They were dropped; substitutes are listed below.' },
  E3: { label: 'Late', tone: 'warn', help: 'Arrives after the requested date, so it goes into a later delivery (a separate cart).' },
  E4: { label: 'Split', tone: 'info', help: 'One product alone is short, so the quantity is split across products.' },
  E5: { label: 'Stock not confirmed', tone: 'warn', help: 'Valio does not confirm stock for this product: any quantity can be ordered, but it is not guaranteed.' },
  E6: { label: 'Some cut-offs passed', tone: 'neutral', help: 'For some products the order deadline for this date has passed. They were dropped.' },
  E7: { label: 'Some without price', tone: 'neutral', help: 'Valio returned no price for some products. They were dropped.' },
  E8: { label: 'Allergen data missing', tone: 'neutral', help: 'Some products have no allergen information. With your limits they were excluded, to be safe.' },
  E9: { label: 'Cached prices', tone: 'bad', help: 'The Valio API did not answer. Recorded offers were used instead.' },
  content_from_price: { label: 'Pack size from price', tone: 'info', help: 'Pack content was missing in product data and was derived from Valio\'s price per litre or kg.' },
  litre_as_kg: { label: 'Litres as kg', tone: 'info', help: 'The recipe weighs this liquid; the product is sold in litres. 1 l is counted as 1 kg.' },
  content_mismatch: { label: 'Pack size corrected', tone: 'info', help: 'Product data and Valio disagreed on pack content. Valio\'s value is used.' },
};
const RULES: Record<string, string> = {
  allergen_and_diet_limits: 'Allergens and diets', alcohol_needs_human: 'Alcohol', need_covered: 'Full quantity covered',
  on_time: 'Arrives on time', live_prices: 'Live prices', request_budget: 'Request budget', agent_may_finalise: 'Agent autonomy',
  max_order_eur: 'Order limit', max_line_eur: 'Line limit', allow_unknown_amount: 'Confirmed stock', allow_split: 'Splitting',
  max_over_best_price_pct: 'Price vs. best option', policy_engine: 'Policy engine',
  matches_request_text: 'Matches your words', usual_quantity: 'Usual quantity',
};
const GS1: Record<string, string> = { AM: 'milk', AW: 'gluten', AE: 'egg', AN: 'tree nuts', AP: 'peanuts', AF: 'fish', AC: 'crustaceans', AY: 'soy', AS: 'sesame', BC: 'celery', BM: 'mustard', AU: 'sulphites', NL: 'lupin', UM: 'molluscs' };
const STATUS: Record<string, { label: string; tone: Tone }> = {
  needs_review: { label: 'Needs review', tone: 'warn' }, auto_approved: { label: 'Auto-approved', tone: 'info' },
  approved: { label: 'Approved', tone: 'ok' }, exported: { label: 'Exported', tone: 'neutral' },
  rejected: { label: 'Rejected', tone: 'bad' }, expired: { label: 'Expired', tone: 'bad' },
};
const CRITERIA = [['price', 'Price'], ['availability', 'Availability'], ['reliability', 'Reliability'], ['co2', 'CO₂'], ['origin', 'Origin']] as const;
const EXAMPLES = [
  'I need 1,000 litres of lactose-free milk by Monday, best on price and availability.',
  'Tarvitsen 200 l laktoositonta maitoa huomenna',
  '300 l lactose-free milk by Wednesday, sustainability first',
];

const eur = (c: number | null | undefined) => (c == null ? '–' : (c / 100).toLocaleString('en-IE', { style: 'currency', currency: 'EUR' }));
const num = (n: number) => n.toLocaleString('en-GB', { maximumFractionDigits: 3 });
const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const clock = (s: string) => new Date(s).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const ago = (s: string) => {
  const m = Math.round((Date.now() - Date.parse(s)) / 60000), rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  return m < 1 ? 'just now' : m < 60 ? rtf.format(-m, 'minute') : m < 1440 ? rtf.format(-Math.round(m / 60), 'hour') : rtf.format(-Math.round(m / 1440), 'day');
};
const who = (actor: string) => { const [role, ...name] = actor.split(':'); return `${name.join(':')} (${role})`; };
const unitLabel = (u: string) => (u === 'pcs' ? 'units' : u);

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
const toast = (text: string, tone: Tone = 'ok') => dispatchEvent(new CustomEvent('toast', { detail: { text, tone } }));

const useHash = () => {
  const [h, set] = useState(location.hash);
  useEffect(() => { const f = () => { set(location.hash); scrollTo(0, 0); }; addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  return h;
};
const usePoll = <T,>(load: () => Promise<T>, ms: number, deps: unknown[]) => {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    let live = true;
    const run = () => load().then((d) => { if (live) setData(d); }, () => {});
    run();
    const t = setInterval(run, ms);
    return () => { live = false; clearInterval(t); };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return data;
};

// ---------- Small building blocks ----------
const PATHS: Record<string, string> = {
  check: 'M20 6 9 17l-5-5', alert: 'M12 8v5m0 3.5h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  x: 'M18 6 6 18M6 6l12 12', lock: 'M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5z', download: 'M12 3v12m0 0-4-4m4 4 4-4M4 21h16',
  back: 'M19 12H5m0 0 6-6m-6 6 6 6', spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
  user: 'M20 21a8 8 0 0 0-16 0m8-8a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z', plus: 'M12 5v14M5 12h14',
  shield: 'M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Zm-3.5 9 2.5 2.5 4.5-5',
  pin: 'M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11Zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  truck: 'M3 6h11v10H3zM14 10h4l3 3v3h-7M7.5 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm10 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2m20 0v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6l3.5-7h13Z',
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5Z',
  external: 'M14 4h6v6m0-6L10 14M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5', loader: 'M12 3a9 9 0 1 0 9 9',
};
function Icon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}><path d={PATHS[name]} /></svg>
  );
}
const Badge = ({ tone = 'neutral', title, children }: { tone?: Tone; title?: string; children: ReactNode }) =>
  <span className={`badge tone-${tone}`} title={title}>{children}</span>;
const Exc = ({ code }: { code: string }) => <Badge tone={EXC[code]?.tone} title={EXC[code]?.help}>{EXC[code]?.label ?? code}</Badge>;
const Status = ({ s }: { s: string }) => <Badge tone={STATUS[s]?.tone}>{STATUS[s]?.label ?? s}</Badge>;
const Callout = ({ tone, icon = 'alert', title, children }: { tone: Tone; icon?: string; title?: string; children?: ReactNode }) => (
  <div className={`callout tone-${tone}`} role={tone === 'bad' ? 'alert' : undefined}>
    <Icon name={icon} size={18} /><div className="callout-body">{title && <strong>{title}</strong>}{children}</div>
  </div>
);
// Read-back: the request as understood, next to the person's own words. Anything not in their text is called out.
function ReadBack({ p }: { p: any }) {
  const rb = p.read_back, r = p.request;
  if (r.recipe) return <RecipeReadBack p={p} />;
  if (!rb) return <p className="muted small readback-none"><Icon name="alert" size={14} />Entered as structured data: no original text to compare with.</p>;
  // ok = from the text, info = assumed or worked out, warn = not in the text at all.
  const Row = ({ tone, title, children }: { tone: Tone; title: string; children?: ReactNode }) => (
    <li className={`check tone-${tone}`}><Icon name={tone === 'ok' ? 'check' : 'alert'} /><div><strong>{title}</strong>{children && <span>{children}</span>}</div></li>
  );
  const limits = [...r.diets.map((d: string) => [d, d.replace('_', '-')]), ...r.exclude_allergens.map((a: string) => [a, `no ${GS1[a] ?? a} (${a})`])];
  return (
    <section className="card readback" aria-label="Request as understood">
      <h2>Understood as</h2>
      <blockquote>“{rb.text}”</blockquote>
      <ul className="checks">
        {r.items.map((it: any, i: number) => (
          <Row key={i} tone={rb.items[i].quantity_in_text ? 'ok' : 'warn'} title={`${num(it.quantity)} ${unitLabel(it.unit)} ${it.need}`}>
            {!rb.items[i].quantity_in_text ? 'This quantity is not in your text. Check it before approving.'
              : rb.items[i].words ? `Your words: “${rb.items[i].words}”` : 'As written'}
          </Row>
        ))}
        <Row tone={rb.deliver_by === 'text' ? 'ok' : 'info'} title={`Deliver by ${day(r.deliver_by)}`}>
          {rb.deliver_by === 'assumed' ? 'Assumed: no date in your text, so the next delivery day.' : rb.deliver_by === 'interpreted' ? 'Worked out from your wording.' : 'As written'}
        </Row>
        {limits.map(([k, label]: string[]) => (
          <Row key={k} tone={rb.added_limits.includes(k) ? 'warn' : 'ok'} title={label}>{rb.added_limits.includes(k) ? 'Added: not in your text.' : 'From your text'}</Row>
        ))}
        {rb.priorities_default && <Row tone="info" title="Priorities: price and availability">Default: your text names no priority.</Row>}
      </ul>
    </section>
  );
}
// Read-back for a recipe order: every quantity traced to its recipe line, and what was left out and why.
function RecipeReadBack({ p }: { p: any }) {
  const rc = p.request.recipe;
  return (
    <section className="card readback" aria-label="Request as understood">
      <div className="card-head">
        <h2>From recipe</h2>
        <a className="small" href={rc.url} target="_blank" rel="noreferrer">Original recipe <Icon name="external" size={12} /></a>
      </div>
      <p className="muted small">{rc.name}: {rc.yield} portions in the recipe, scaled to {rc.portions} (× {num(rc.portions / rc.yield)}). Quantities round up to 10 g.</p>
      <ul className="checks">
        {rc.from.map((f: string, i: number) => <li key={i} className="check tone-ok"><Icon name="check" /><div><span>{f}</span></div></li>)}
        {rc.skipped.map((x: any, i: number) => (
          <li key={`s${i}`} className="check tone-info"><Icon name="alert" /><div><strong>Not bought: {x.text}</strong><span>{
            x.reason === 'usually in stock' ? 'Usually in stock. Tick it on the recipe page to buy it.' : x.reason === 'to taste' ? 'To taste, no amount given.' : 'Nothing to buy (water).'}</span></div></li>
        ))}
      </ul>
    </section>
  );
}

const DIET_FI: Record<string, string> = { Laktoositon: 'lactose_free', Gluteeniton: 'gluten_free', Vegaaninen: 'vegan' };
function Recipes({ token }: { token: string }) {
  const [list, setList] = useState<any[] | null>(null);
  const [err, setErr] = useState('');
  const [diet, setDiet] = useState('');
  useEffect(() => { api(token, 'GET', '/recipes').then(setList, (e) => setErr(e.message)); }, [token]);
  if (err) return <Callout tone="bad" title="Could not load recipes">{err}</Callout>;
  if (!list) return <Loading />;
  const shown = list.filter((r) => !diet || r.diets.includes(diet));
  return (
    <>
      <div className="page-head"><div>
        <h1>Recipes</h1>
        <p className="lead">Valio Aimo professional-kitchen recipes. Pick one, say how many portions, and the agent plans every ingredient into one order.</p>
      </div></div>
      {!list.length ? <Callout tone="info" title="No recipes yet">Run <code>npm run recipes</code> once (online) to fetch them.</Callout> : <>
        <div className="checks-row" role="group" aria-label="Filter by diet" style={{ marginBottom: 16 }}>
          {['', ...Object.keys(DIET_FI)].map((d) => (
            <button key={d} className="chip-btn" aria-pressed={diet === d} onClick={() => setDiet(d)}>{d || 'All'} <span className="muted">{d ? list.filter((r) => r.diets.includes(d)).length : list.length}</span></button>
          ))}
        </div>
        <div className="recipe-grid">{shown.map((r) => (
          <a key={r.id} className="card recipe-card" href={`#/recipes/${r.id}`}>
            {r.image ? <img src={r.image} alt="" loading="lazy" /> : <div className="img" />}
            <div className="body">
              <span className="muted small">{r.course}</span>
              <strong>{r.name}</strong>
              <span className="muted small">{r.yield} portions · {r.ingredients} ingredients</span>
              {!!r.diets.length && <div className="badges">{r.diets.filter((d: string) => DIET_FI[d]).map((d: string) => <Badge key={d} tone="ok">{d}</Badge>)}</div>}
            </div>
          </a>
        ))}</div>
      </>}
    </>
  );
}

function RecipePage({ id, token }: { id: string; token: string }) {
  const [r, setR] = useState<any>(null);
  const [err, setErr] = useState('');
  const [portions, setPortions] = useState(100);
  const [pantry, setPantry] = useState<string[]>([]);
  const [diets, setDiets] = useState<string[]>([]);
  const [date, setDate] = useState('2026-11-18');
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState('');
  useEffect(() => { api(token, 'GET', `/recipes/${id}`).then(setR, (e) => setErr(e.message)); }, [id, token]);
  if (!r) return err ? <Callout tone="bad" title="Could not load the recipe">{err}</Callout> : <Loading />;
  const buy = r.lines.filter((l: any) => l.need && l.kg > 0 && (!l.pantry || pantry.includes(l.need))).length;
  const plan = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(''); setQuestion('');
    try {
      const p = await api(token, 'POST', `/recipes/${id}/plan`, { portions, pantry, diets, deliver_by: date || undefined });
      toast('Proposal ready.'); location.hash = `#/p/${p.id}`;
    } catch (e) { const q = (e as ApiError).body?.question; if (q) setQuestion(q); else setErr((e as Error).message); setBusy(false); }
  };
  const toggle = (xs: string[], x: string) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);
  return (
    <>
      <a href="#/recipes" className="back"><Icon name="back" />All recipes</a>
      <div className="page-head"><div>
        <h1>{r.name}</h1>
        <div className="meta">
          <span>{r.course}</span><span>{r.yield} portions in the recipe</span>
          <a href={r.url} target="_blank" rel="noreferrer">Original on valioaimo.fi <Icon name="external" size={12} /></a>
        </div>
      </div></div>
      <div className="recipe-layout">
        <section className="card">
          {r.image && <img className="recipe-hero" src={r.image} alt="" />}
          <h2>Ingredients for {num(portions)} portions</h2>
          <div className="scroll"><table className="data">
            <thead><tr><th>In the recipe ({r.yield} portions)</th><th className="r">To buy</th><th>Buy?</th></tr></thead>
            <tbody>{r.lines.map((l: any, i: number) => {
              const scaled = Math.ceil(+(l.kg * portions / r.yield * 100).toFixed(6)) / 100;
              return (
                <tr key={i}>
                  <td><div>{l.text}</div>{l.need && <div className="cell-sub">searches “{l.need}”{l.product && <> · <Icon name="check" size={12} />Valio product named</>}</div>}</td>
                  <td className="r num">{l.need && l.kg > 0 ? `${num(scaled)} kg` : '–'}</td>
                  <td>{!l.need ? <span className="muted small">Nothing to buy</span>
                    : l.kg <= 0 ? <span className="muted small">To taste</span>
                    : l.pantry ? <label className="check-pill small"><input type="checkbox" checked={pantry.includes(l.need)} onChange={() => setPantry(toggle(pantry, l.need))} />Usually in stock, buy anyway</label>
                    : <Badge tone="ok">Buy</Badge>}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        </section>
        <aside className="rail">
          <form className="card" onSubmit={plan}>
            <h2>Plan the order</h2>
            <div className="field"><label htmlFor="portions">Portions</label>
              <input id="portions" type="number" min={1} max={5000} step={1} required value={portions} onChange={(e) => setPortions(Math.max(1, Math.round(+e.target.value)))} />
              <span className="hint">× {num(portions / r.yield)} the recipe</span></div>
            <div className="field"><label htmlFor="rdate">Deliver by</label>
              <input id="rdate" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              <span className="hint">Monday's order cut-offs have passed for many products.</span></div>
            <fieldset className="field" style={{ border: 0, padding: 0, margin: '0 0 14px' }}>
              <legend>Diets for every ingredient</legend>
              <div className="checks-row">{['lactose_free', 'gluten_free', 'vegan'].map((d) => (
                <label key={d} className="check-pill"><input type="checkbox" checked={diets.includes(d)} onChange={() => setDiets(toggle(diets, d))} />{d.replace('_', '-')}</label>
              ))}</div>
            </fieldset>
            <button className="btn primary block" disabled={busy || !buy} aria-busy={busy}>
              {busy ? <><Icon name="loader" className="spin" />Checking {buy} ingredients with Valio…</> : `Plan order for ${buy} ingredients`}
            </button>
            {question && <Callout tone="info" title="One question first">{question}</Callout>}
            {err && <Callout tone="bad" title="Could not plan the order">{err}</Callout>}
          </form>
        </aside>
      </div>
    </>
  );
}

const Loading = () => <div className="card" aria-busy="true"><div className="skeleton" style={{ width: '40%' }} /><div className="skeleton" /><div className="skeleton" style={{ width: '70%' }} /></div>;

function Toasts() {
  const [items, set] = useState<{ id: number; text: string; tone: Tone }[]>([]);
  useEffect(() => {
    const f = (e: Event) => {
      const id = Math.random();
      set((xs) => [...xs, { id, ...(e as CustomEvent).detail }]);
      setTimeout(() => set((xs) => xs.filter((x) => x.id !== id)), 4500);
    };
    addEventListener('toast', f);
    return () => removeEventListener('toast', f);
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => <div key={t.id} className={`toast tone-${t.tone}`}><Icon name={t.tone === 'ok' ? 'check' : 'alert'} size={18} />{t.text}</div>)}
    </div>
  );
}

// ---------- Shell ----------
function App() {
  const [token, setToken] = useState(() => { try { return localStorage.getItem('token') ?? USERS[0].token; } catch { return USERS[0].token; } });
  const hash = useHash();
  const pick = (t: string) => { setToken(t); try { localStorage.setItem('token', t); } catch { /* private mode */ } };
  const rows = usePoll<any[]>(() => api(token, 'GET', '/proposals'), 5000, [token]);
  const waiting = rows?.filter((r) => r.status === 'needs_review').length ?? 0;
  const id = hash.match(/^#\/p\/(.+)$/)?.[1];
  const recipe = hash.match(/^#\/recipes\/(.+)$/)?.[1];
  const page = id ? 'proposal' : recipe ? 'recipe' : hash.startsWith('#/recipes') ? 'recipes' : hash.startsWith('#/new') ? 'new' : hash.startsWith('#/policy') ? 'policy' : 'list';
  const approver = token === 'demo-approver';
  return (
    <>
      <header className="topbar">
        <a href="#" className="brand" aria-label="Trusted Trade Agents, home">
          <span className="brand-mark"><Icon name="shield" size={18} /></span>
          <span><strong>Trusted Trade Agents</strong><small>Hotel Kaisla · purchasing</small></span>
        </a>
        <nav className="nav" aria-label="Main">
          <a href="#" aria-current={page === 'list' || page === 'proposal' ? 'page' : undefined}>
            Proposals {waiting > 0 && <span className="count" aria-label={`${waiting} waiting for review`}>{waiting}</span>}
          </a>
          <a href="#/new" aria-current={page === 'new' ? 'page' : undefined}><Icon name="plus" size={15} />New request</a>
          <a href="#/recipes" aria-current={page === 'recipes' || page === 'recipe' ? 'page' : undefined}><Icon name="book" size={15} />Recipes</a>
          <a href="#/policy" aria-current={page === 'policy' ? 'page' : undefined}>Policy</a>
        </nav>
        <div className="segmented" role="group" aria-label="Signed in as">
          {USERS.map((u) => (
            <button key={u.token} aria-pressed={token === u.token} onClick={() => pick(u.token)} title={`${u.name} (${u.role})`}>
              <Icon name="user" size={14} />{u.role}
            </button>
          ))}
        </div>
      </header>
      <main className="container">
        {approver && page === 'list' && <TrustBanner token={token} />}
        {page === 'proposal' ? <Proposal key={id + token} id={id!} token={token} />
          : page === 'new' ? <NewRequest token={token} />
          : page === 'recipes' ? <Recipes token={token} />
          : page === 'recipe' ? <RecipePage key={recipe} id={recipe!} token={token} />
          : page === 'policy' ? <Policy key={hash + token} token={token} suggest={hash.endsWith('?suggest')} />
          : <List rows={rows} />}
      </main>
      <Toasts />
    </>
  );
}

// §8.4: a suggestion only; the approver reviews the values and saves the policy themselves.
function TrustBanner({ token }: { token: string }) {
  const [t, setT] = useState<any>(null);
  useEffect(() => { api(token, 'GET', '/trust').then(setT, () => setT(null)); }, [token]);
  if (!t?.suggestion) return null;
  return (
    <div className="callout tone-ok">
      <Icon name="spark" size={18} />
      <div className="callout-body"><strong>Trust is building</strong><p>{t.suggestion.text}</p></div>
      <a className="btn sm" href="#/policy?suggest">Review suggestion</a>
    </div>
  );
}

// ---------- Proposal list ----------
function List({ rows }: { rows: any[] | null }) {
  const [tab, setTab] = useState<'review' | 'ready' | 'all'>('review');
  if (!rows) return <Loading />;
  const groups = {
    review: rows.filter((r) => r.status === 'needs_review'),
    ready: rows.filter((r) => ['approved', 'auto_approved'].includes(r.status)),
    all: rows,
  };
  const TABS = [['review', 'Needs review'], ['ready', 'Ready to export'], ['all', 'All']] as const;
  const shown = groups[tab];
  return (
    <>
      <div className="page-head">
        <div><h1>Proposals</h1><p className="lead">Orders prepared by agents and your team. Proposals made over MCP appear here on their own.</p></div>
        <a className="btn primary" href="#/new"><Icon name="plus" />New request</a>
      </div>
      <section className="card">
        <div className="tabs" role="tablist" aria-label="Filter proposals">
          {TABS.map(([k, label]) => (
            <button key={k} role="tab" className="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
              {label}<span className="n">{groups[k].length}</span>
            </button>
          ))}
        </div>
        {!shown.length ? (
          <div className="empty">
            <Icon name="inbox" size={32} />
            <strong>{tab === 'review' ? 'Nothing waiting for you' : 'No proposals here yet'}</strong>
            <p>{tab === 'review' ? 'New proposals that need a human appear here.' : <>Ask an agent, or <a href="#/new">make a request</a>.</>}</p>
          </div>
        ) : (
          <div className="scroll"><table className="data">
            <thead><tr><th>Request</th><th>Delivery</th><th>Status</th><th className="r">Total</th><th>Created</th></tr></thead>
            <tbody>{shown.map((r) => (
              <tr key={r.id} className="clickable" onClick={() => (location.hash = `#/p/${r.id}`)}>
                <td><a className="cell-title" href={`#/p/${r.id}`} onClick={(e) => e.stopPropagation()}>{r.recipe ?? r.needs.join(', ')}</a><div className="cell-sub">{r.recipe && <><Icon name="book" size={12} />{r.needs.length} ingredients ·</>} {r.site}</div></td>
                <td>{day(r.deliver_by)}</td>
                <td><Status s={r.status} /></td>
                <td className="r num">{eur(r.total_cents)}</td>
                <td><div>{ago(r.created_at)}</div><div className="cell-sub">{who(r.created_by)}</div></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </>
  );
}

// ---------- Proposal ----------
function Proposal({ id, token }: { id: string; token: string }) {
  const [p, setP] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [diffs, setDiffs] = useState<any[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const load = useCallback(() => Promise.all([api(token, 'GET', `/proposals/${id}`), api(token, 'GET', `/audit?proposal=${id}`)])
    .then(([p, e]) => { setP(p); setEvents(e); }, (e) => setErr(e.message)), [id, token]);
  useEffect(() => { load(); }, [load]);
  const act = async (label: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(label); setErr(''); setDiffs(null);
    try { await fn(); if (done) toast(done); } catch (e) { setErr((e as Error).message); setDiffs((e as ApiError).body?.diffs ?? null); }
    await load(); setBusy(null);
  };
  const revise = (item: number, rev: object) => act('revise', () => api(token, 'PATCH', `/proposals/${id}`, { item, ...rev }), 'Proposal updated. All checks re-run.');
  const decide = (decision: 'approve' | 'reject') => {
    if (decision === 'reject' && !confirm('Reject this proposal? Nothing will be ordered.')) return;
    act(decision, () => api(token, 'POST', `/proposals/${id}/decision`, { decision, note: note || undefined }),
      decision === 'approve' ? 'Approved. Prices and stock were re-checked with Valio.' : 'Proposal rejected.');
  };

  if (!p) return err ? <Callout tone="bad" title="Could not load the proposal">{err}</Callout> : <Loading />;
  const open = ['needs_review', 'auto_approved'].includes(p.status);
  const approver = token === 'demo-approver';
  const failed = p.policy_verdict.rules.filter((r: any) => !r.ok);
  const passed = p.policy_verdict.rules.filter((r: any) => r.ok);
  return (
    <>
      <a href="#" className="back"><Icon name="back" />All proposals</a>
      <div className="page-head">
        <div>
          <h1>{p.request.recipe ? `${p.request.recipe.name} × ${p.request.recipe.portions} portions`
            : p.items.map((it: any) => `${num(it.item.quantity)} ${unitLabel(it.item.unit)} ${it.item.need}`).join(' · ')}</h1>
          <div className="meta">
            <span><Icon name="pin" size={14} />{p.site}</span>
            <span><Icon name="truck" size={14} />Deliver by {day(p.deliver_by)}{p.deliver_by_defaulted && ' (next delivery day)'}</span>
            <span><Icon name="user" size={14} />{who(p.created_by)}, {ago(p.created_at)}</span>
          </div>
        </div>
      </div>
      <div className="proposal-grid">
        <div>
          {err && !diffs && <Callout tone="bad" title="That did not work">{err}</Callout>}
          {diffs && (
            <Callout tone="warn" title="Offers changed since this proposal was made">
              <ul>{diffs.map((d, i) => <li key={i}>#{d.id}: {d.what.replace('_', ' ')} {String(d.before)} → {String(d.after)}</li>)}</ul>
              <p>Review the lines, then approve again.</p>
            </Callout>
          )}
          <ReadBack p={p} />
          {p.items.map((it: any, i: number) => <Item key={i} it={it} open={open} busy={!!busy} revise={(rev) => revise(i, rev)} />)}
          <Timeline events={events} />
        </div>

        <aside className="rail" aria-label="Decision">
          <section className="card decision">
            <div className="card-head"><Status s={p.status} /><span className="muted small">{p.items.reduce((n: number, it: any) => n + it.allocation.length, 0)} line(s)</span></div>
            <p className="total num">{eur(p.total_cents)}</p>
            <p className="vat">excl. VAT · prices fixed from Valio</p>
            <p className="next">{p.next}</p>
            <div className="actions">
              {['approved', 'auto_approved', 'exported'].includes(p.status) && (
                <button className="btn primary block" disabled={!!busy} onClick={() => act('export', () => download(token, id), 'Import file downloaded.')}>
                  <Icon name="download" />Download webshop import file
                </button>
              )}
              {open && approver && (
                <>
                  <label className="sr-only" htmlFor="note">Note for the decision record</label>
                  <input id="note" className="note" placeholder="Note for the record (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
                  <div className="two">
                    <button className={`btn ${p.status === 'needs_review' ? 'primary' : ''}`} disabled={!!busy} aria-busy={busy === 'approve'} onClick={() => decide('approve')}>
                      {busy === 'approve' ? <><Icon name="loader" className="spin" />Re-checking prices…</> : <><Icon name="check" />Approve</>}
                    </button>
                    <button className="btn danger" disabled={!!busy} onClick={() => decide('reject')}><Icon name="x" />Reject</button>
                  </div>
                </>
              )}
              {open && !approver && <Callout tone="neutral" icon="lock">Waiting for an approver. You can still adjust the lines.</Callout>}
            </div>
          </section>

          <section className="card">
            <h2>{failed.length ? 'Why a human must decide' : 'All checks passed'}</h2>
            {!failed.length && <p className="muted small" style={{ marginTop: 6 }}>The policy lets this proposal finalise without a human.</p>}
            <ul className="checks">
              {failed.map((r: any) => (
                <li key={r.rule} className={`check tone-${r.hard ? 'bad' : 'warn'}`}>
                  <Icon name={r.hard ? 'lock' : 'alert'} />
                  <div><strong>{RULES[r.rule] ?? r.rule}</strong><span>{r.detail}</span>{r.hard && <div><em>Hard rule: no setting changes it</em></div>}</div>
                </li>
              ))}
            </ul>
            {!!passed.length && (
              <details className="passed">
                <summary>{passed.length} checks passed</summary>
                <ul className="checks">{passed.map((r: any) => (
                  <li key={r.rule} className="check tone-ok"><Icon name="check" /><div><strong>{RULES[r.rule] ?? r.rule}</strong><span>{r.detail}</span></div></li>
                ))}</ul>
              </details>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}

function Item({ it, open, busy, revise }: { it: any; open: boolean; busy: boolean; revise: (rev: object) => void }) {
  const [qty, setQty] = useState(it.item.quantity);
  const [all, setAll] = useState(false);
  const unit = unitLabel(it.item.unit);
  const chosen = new Set(it.allocation.map((a: any) => a.id));
  const mode = it.overrides?.choose ? 'choose' : it.overrides?.confirmed_only ? 'confirmed' : 'best';
  const prices = it.options.map((o: any) => o.unit_price_cents);
  const best = Math.min(...prices), worst = Math.max(...prices);
  const setQuantity = (e: FormEvent) => { e.preventDefault(); if (qty > 0 && qty !== it.item.quantity) revise({ quantity: qty }); };
  return (
    <section className="card" aria-labelledby={`item-${it.item.need}`}>
      <div className="card-head">
        <div>
          <h2 id={`item-${it.item.need}`}>{num(it.item.quantity)} {unit} · {it.item.need}</h2>
          <p className="muted small">
            {it.options.length} deliverable options{it.category && ` · category ${it.category}`}
            {it.ai_check && (it.ai_check.answered
              ? <> · <span title={`The model only narrows name matches to the product asked for; removals are listed below.`}>product type checked by {it.ai_check.model}</span></>
              : <> · AI product check unavailable, name matches only</>)}
          </p>
        </div>
        <div className="badges">{it.exceptions.map((e: string) => <Exc key={e} code={e} />)}</div>
      </div>
      {it.named && (
        <p className={`named small tone-${it.named.used ? 'ok' : 'warn'}`}>
          <Icon name={it.named.used ? 'check' : 'alert'} size={14} />
          <span>Named in the request: <strong>{it.named.name}</strong>{it.named.used ? ', used.' : ` — not used: ${it.named.why}.`}</span>
        </p>
      )}
      {it.errors.map((e: string) => <Callout key={e} tone="bad" title="Valio API trouble">{e}</Callout>)}
      {it.shortfall > 0 && (() => {
        const why = it.dropped.reduce((m: Record<string, number>, d: any) => { for (const r of d.reasons) m[r] = (m[r] ?? 0) + 1; return m; }, {});
        return (
          <Callout tone="warn" title="Not fully covered">
            <p>{num(it.shortfall)} of {num(it.item.quantity)} {unit} could not be allocated.</p>
            {mode === 'confirmed' && it.options.some((o: any) => o.available === null) && <p>Only options with confirmed stock are used. Switch to <strong>Best overall</strong> to include options whose stock Valio does not confirm.</p>}
            {!it.options.length && !!it.dropped.length && <p>Nothing matching “{it.item.need}” can be delivered by this date: {Object.entries(why).map(([r, n]) => `${n} × ${r}`).join(', ')}. Try a later delivery date.</p>}
            {!it.options.length && !it.dropped.length && <p>No product matched “{it.item.need}” within your limits. Try another word (Finnish names match best).</p>}
          </Callout>
        );
      })()}

      <h3>Order lines</h3>
      {!it.allocation.length ? <p className="muted">No line could be planned for this item.</p> : (
        <ul className="lines">{it.allocation.map((a: any) => (
          <li key={a.id} className="line">
            <div>
              <div className="line-name">{a.name}</div>
              <div className="line-meta">#{a.id} · arrives {day(a.date)} {a.flags.map((f: string) => <Exc key={f} code={f} />)}</div>
              <p className="line-why"><Icon name="spark" size={14} /><span>{a.reason}</span></p>
            </div>
            <dl className="line-nums">
              <div><dt>Quantity</dt><dd>{num(a.sales_units)} {a.sales_unit}</dd></div>
              <div><dt>Unit price</dt><dd>{eur(Math.round(a.cost_cents / a.sales_units))}</dd></div>
              <div><dt>Line total</dt><dd className="strong">{eur(a.cost_cents)}</dd></div>
            </dl>
          </li>
        ))}</ul>
      )}

      {open && (
        <div className="toolbar">
          <div className="segmented" role="group" aria-label="How to allocate">
            <button aria-pressed={mode === 'best'} disabled={busy} onClick={() => revise({})}>Best overall</button>
            <button aria-pressed={mode === 'confirmed'} disabled={busy} onClick={() => revise({ confirmed_only: true })}>Confirmed stock only</button>
          </div>
          <form className="qty" onSubmit={setQuantity}>
            <label htmlFor={`qty-${it.item.need}`} className="muted">Quantity</label>
            <input id={`qty-${it.item.need}`} type="number" min={0} step="any" value={qty} onChange={(e) => setQty(+e.target.value)} />
            <span className="muted">{unit}</span>
            <button className="btn sm" disabled={busy || !(qty > 0) || qty === it.item.quantity}>Update</button>
          </form>
        </div>
      )}

      <h3>Alternatives</h3>
      <div className="legend" aria-hidden="true"><span>Score bars:</span>{CRITERIA.map(([, l]) => <span key={l}>{l}</span>)}</div>
      <div className="scroll"><table className="data">
        <thead><tr><th>Product</th><th className="r">Price / {it.item.unit === 'pcs' ? 'unit' : it.item.unit}</th><th className="r">Available</th><th className="r">Score</th><th /></tr></thead>
        <tbody>{it.options.filter((o: any, i: number) => all || i < 6 || chosen.has(o.id)).map((o: any) => {
          const delta = Math.round((o.unit_price_cents / best - 1) * 100);
          return (
            <tr key={o.id} className={chosen.has(o.id) ? 'in-order' : undefined}>
              <td>
                <div className="cell-title">{o.name}</div>
                <div className="cell-sub">#{o.id}{o.late && <Exc code="E3" />}{o.content_flag && <Exc code={o.content_flag} />}</div>
              </td>
              <td className="r" style={{ minWidth: 130 }}>
                <div className="pricecell"><span className="num">{eur(Math.round(o.unit_price_cents))}</span><span className={`delta ${delta === 0 ? 'best' : ''}`}>{delta === 0 ? 'best' : `+${delta}%`}</span></div>
                <div className="bar" aria-hidden="true"><span style={{ width: `${(o.unit_price_cents / worst) * 100}%` }} /></div>
              </td>
              <td className="r">{o.available === null ? <Exc code="E5" /> : <span className="num">{num(o.available)} {o.offer.sales_unit}</span>}</td>
              <td className="r">
                <span className="score">
                  <span className="minibars" role="img" aria-label={CRITERIA.map(([k, l]) => `${l} ${o.criteria[k] == null ? 'n/a' : o.criteria[k].toFixed(2)}`).join(', ')}>
                    {CRITERIA.map(([k, l]) => <i key={k} className={o.criteria[k] == null ? 'na' : undefined} title={`${l}: ${o.criteria[k] == null ? 'no data' : o.criteria[k].toFixed(2)}`} style={{ height: `${(o.criteria[k] ?? 0) * 100}%` }} />)}
                  </span>
                  <span className="num">{o.score.toFixed(2)}</span>
                </span>
              </td>
              <td className="r">
                {chosen.has(o.id) ? <Badge tone="ok">In order</Badge>
                  : open && <button className="btn sm" disabled={busy} onClick={() => revise({ choose: o.id })}>Choose</button>}
              </td>
            </tr>
          );
        })}</tbody>
      </table></div>
      {it.options.length > 6 && (
        <button className="btn ghost sm" style={{ marginTop: 8 }} aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? 'Show top 6' : `Show all ${it.options.length} alternatives`}
        </button>
      )}

      {!!it.dropped.length && (
        <details className="more">
          <summary>{it.dropped.length} not deliverable, past cut-off or without price</summary>
          <div className="scroll"><table className="data"><tbody>{it.dropped.map((d: any) => (
            <tr key={d.id}>
              <td><div className="cell-title">{d.name}</div><div className="cell-sub">#{d.id}</div></td>
              <td>{d.reasons.join('; ')}</td>
              <td className="muted small">{d.substitutes.length ? `Substitutes: ${d.substitutes.map((s: string) => '#' + s).join(', ')}` : ''}</td>
            </tr>
          ))}</tbody></table></div>
        </details>
      )}
      {!!it.excluded_total && (
        <details className="more">
          <summary>{it.excluded_total} excluded by your limits or the product check{it.excluded_total > it.excluded.length && ` (first ${it.excluded.length} shown)`}</summary>
          <div className="scroll"><table className="data"><tbody>{it.excluded.map((d: any) => (
            <tr key={d.id}><td><div className="cell-title">{d.name}</div><div className="cell-sub">#{d.id}</div></td><td>{d.reasons.join('; ')}</td></tr>
          ))}</tbody></table></div>
        </details>
      )}
    </section>
  );
}

function summarize(e: any): { title: string; text?: string; tone: Tone } {
  const d = e.data;
  switch (e.event) {
    case 'created': return { title: 'Proposal created', tone: 'info',
      text: d.items.map((it: any) => `${num(it.item.quantity)} ${unitLabel(it.item.unit)} ${it.item.need} → ${it.allocation.length} line(s), ${eur(it.allocation.reduce((s: number, a: any) => s + a.cost_cents, 0))}`).join('; ') };
    case 'policy_verdict': return d.requires_human
      ? { title: 'Policy: a human must sign off', tone: 'warn', text: d.rules.filter((r: any) => !r.ok).map((r: any) => RULES[r.rule] ?? r.rule).join(' · ') }
      : { title: 'Policy: all checks passed', tone: 'ok', text: 'The agent may finalise this proposal.' };
    case 'revised': { const r = d.revision; return { title: 'Lines revised', tone: 'info',
      text: r.choose ? `Chose product #${r.choose}` : r.confirmed_only ? 'Confirmed stock only' : r.quantity ? `Quantity set to ${num(r.quantity)}` : 'Back to best overall' }; }
    case 'revalidation_failed': return { title: 'Offers changed before approval', tone: 'bad',
      text: d.diffs.map((x: any) => `#${x.id} ${x.what.replace('_', ' ')}: ${x.before} → ${x.after}`).join('; ') };
    case 'approved': return { title: 'Approved', tone: 'ok', text: `Prices and stock re-checked with Valio${d.note ? ` · “${d.note}”` : ''}` };
    case 'rejected': return { title: 'Rejected', tone: 'bad', text: d.note };
    case 'exported': return { title: 'Exported for the webshop', tone: 'neutral', text: `${d.lines} line(s) · SHA-256 ${d.sha256.slice(0, 12)}…` };
    default: return { title: e.event, tone: 'neutral' };
  }
}

function Timeline({ events }: { events: any[] }) {
  return (
    <section className="card">
      <h2>Decision record</h2>
      <p className="muted small" style={{ marginTop: 4 }}>Every step, append-only: nothing here can be edited or deleted.</p>
      <ol className="timeline">{events.map((e) => {
        const s = summarize(e);
        return (
          <li key={e.seq} className={`tl tone-${s.tone}`}>
            <span className="tl-dot" aria-hidden="true" />
            <div className="tl-head"><strong>{s.title}</strong><span className="muted small">{clock(e.at)} · {who(e.actor)}</span></div>
            {s.text && <p>{s.text}</p>}
            <details><summary>Raw record</summary><pre>{JSON.stringify(e.data, null, 2)}</pre></details>
          </li>
        );
      })}</ol>
    </section>
  );
}

// ---------- New request ----------
function NewRequest({ token }: { token: string }) {
  const [text, setText] = useState(EXAMPLES[0]);
  const [question, setQuestion] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const create = async (body: object) => {
    const p = await api(token, 'POST', '/proposals', { site: 'Hotel Kaisla Helsinki', ...body });
    toast('Proposal ready.');
    location.hash = `#/p/${p.id}`;
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErr(''); setQuestion('');
    try { await fn(); } catch (e) { const q = (e as ApiError).body?.question; if (q) setQuestion(q); else setErr((e as Error).message); setBusy(false); }
  };
  const fromText = (e: FormEvent) => { e.preventDefault(); run(async () => {
    const { request, clarification } = await api(token, 'POST', '/parse', { text });
    if (clarification) { setQuestion(clarification); setBusy(false); return; }
    await create(request);
  }); };
  const fromForm = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const list = (k: string) => String(f.get(k) ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    run(() => create({
      site: f.get('site'), deliver_by: f.get('deliver_by') || undefined, priorities: f.get('priorities'),
      items: [{ need: f.get('need'), quantity: Number(f.get('quantity')), unit: f.get('unit') }],
      diets: f.getAll('diets'), exclude_allergens: list('allergens'),
    }));
  };
  return (
    <div className="narrow">
      <div className="page-head"><div>
        <h1>New request</h1>
        <p className="lead">Say what you need. The agent finds matching products, checks live prices and stock with Valio, and prepares an order for approval.</p>
      </div></div>
      <form className="card composer" onSubmit={fromText}>
        <label htmlFor="text" className="sr-only">What do you need?</label>
        <textarea id="text" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. 1,000 litres of lactose-free milk by Monday" required />
        <div className="examples"><span>Try:</span>{EXAMPLES.map((x) => <button type="button" key={x} className="chip-btn" onClick={() => setText(x)}>{x}</button>)}</div>
        <div className="composer-foot">
          <span className="muted small">English, Finnish or Swedish. Diets and allergens you mention are always applied.</span>
          <button className="btn primary" disabled={busy || !text.trim()} aria-busy={busy}>
            {busy ? <><Icon name="loader" className="spin" />Checking prices with Valio…</> : 'Plan order'}
          </button>
        </div>
      </form>
      {question && <Callout tone="info" title="One question first">{question}</Callout>}
      {err && <Callout tone="bad" title="Could not plan the order">{err}</Callout>}

      <details className="card">
        <summary>Use the structured form instead</summary>
        <form onSubmit={fromForm} style={{ marginTop: 16 }}>
          <div className="field"><label htmlFor="site">Site</label><input id="site" name="site" required defaultValue="Hotel Kaisla Helsinki" /></div>
          <div className="grid-3">
            <div className="field"><label htmlFor="need">Product</label><input id="need" name="need" required defaultValue="maito" /></div>
            <div className="field"><label htmlFor="quantity">Quantity</label><input id="quantity" name="quantity" type="number" min="0.001" step="any" required defaultValue={1000} /></div>
            <div className="field"><label htmlFor="unit">Unit</label><select id="unit" name="unit" defaultValue="l"><option value="l">litres</option><option value="kg">kg</option><option value="pcs">units</option></select></div>
          </div>
          <div className="field"><label htmlFor="deliver_by">Deliver by</label><input id="deliver_by" name="deliver_by" type="date" defaultValue="2026-11-16" /><span className="hint">Empty: next delivery day.</span></div>
          <fieldset className="field" style={{ border: 0, padding: 0, margin: '0 0 14px' }}>
            <legend>Diets</legend>
            <div className="checks-row">{['lactose_free', 'gluten_free', 'vegan', 'vegetarian'].map((d) => (
              <label key={d} className="check-pill"><input type="checkbox" name="diets" value={d} defaultChecked={d === 'lactose_free'} />{d.replace('_', '-')}</label>
            ))}</div>
          </fieldset>
          <div className="field"><label htmlFor="allergens">Exclude allergens</label><input id="allergens" name="allergens" placeholder="e.g. AN, AE" />
            <span className="hint">GS1 codes, comma separated: AM milk, AW gluten, AE egg, AN tree nuts, AP peanuts, AF fish, AY soy.</span></div>
          <div className="field"><label htmlFor="priorities">Priorities</label>
            <select id="priorities" name="priorities"><option value="price_and_availability">Price and availability</option><option value="sustainability">Sustainability</option><option value="reliability_first">Reliability first</option></select>
          </div>
          <button className="btn primary" disabled={busy}>{busy ? 'Planning…' : 'Create proposal'}</button>
        </form>
      </details>
    </div>
  );
}

// ---------- Policy ----------
function Policy({ token, suggest }: { token: string; suggest: boolean }) {
  const [saved, setSaved] = useState<any>(null);
  const [pol, setPol] = useState<any>(null);
  const [err, setErr] = useState('');
  const [fromTrust, setFromTrust] = useState(false);
  useEffect(() => {
    Promise.all([api(token, 'GET', '/policy'), suggest ? api(token, 'GET', '/trust') : null]).then(([p, t]) => {
      setSaved(p); setPol(t?.suggestion?.policy ?? p); setFromTrust(!!t?.suggestion);
    }, (e) => setErr(e.message));
  }, [token, suggest]);
  if (!pol) return err ? <Callout tone="bad" title="Could not load the policy">{err}</Callout> : <Loading />;
  const approver = token === 'demo-approver';
  const dirty = JSON.stringify(pol) !== JSON.stringify(saved);
  const set = (k: string, v: unknown) => setPol({ ...pol, [k]: v });
  const save = () => api(token, 'PUT', '/policy', pol).then((p) => { setSaved(p); setPol(p); setFromTrust(false); toast('Policy saved. It applies to new proposals and revisions.'); }, (e) => setErr(e.message));
  // Plain render helpers, not components: keeps input focus while typing.
  const toggle = (k: string, title: string, desc: string) => (
    <label className="setting">
      <div><strong>{title}</strong><p>{desc}</p></div>
      <input type="checkbox" role="switch" className="switch" disabled={!approver} checked={pol[k]} onChange={(e) => set(k, e.target.checked)} aria-label={title} />
    </label>
  );
  const amount = (k: string, title: string, desc: string, suffix: string) => (
    <div className="setting">
      <div><label htmlFor={k}><strong>{title}</strong></label><p>{desc}</p></div>
      <span className="input-affix"><input id={k} type="number" min={0} disabled={!approver} value={pol[k]} onChange={(e) => set(k, +e.target.value)} /><span>{suffix}</span></span>
    </div>
  );
  return (
    <div className="narrow">
      <div className="page-head"><div>
        <h1>Policy</h1>
        <p className="lead">When every check passes, an agent may finalise an order on its own. Otherwise a human signs off. Agent keys can only be stricter than this.</p>
      </div></div>
      {fromTrust && <Callout tone="ok" icon="spark" title="Suggested from your approval history">Nothing changes until you save.</Callout>}
      {!approver && <Callout tone="neutral" icon="lock">Only an approver can change the policy.</Callout>}
      {err && <Callout tone="bad">{err}</Callout>}

      <section className="card">
        <h2>Autonomy</h2>
        {toggle('agent_may_finalise', 'Agent may finalise orders', 'Off: a human signs off every order. This is Valio\'s expectation today.')}
      </section>
      <section className="card">
        <h2>Limits</h2>
        {amount('max_order_eur', 'Order limit', 'Above this total, a human signs off.', '€')}
        {amount('max_line_eur', 'Line limit', 'Above this per line, a human signs off.', '€')}
        {amount('max_over_best_price_pct', 'Price vs. best option', 'How much more per litre or kg than the cheapest eligible option.', '%')}
      </section>
      <section className="card">
        <h2>Stock and splitting</h2>
        {toggle('allow_unknown_amount', 'Allow unconfirmed stock', 'Lines where Valio does not confirm the available amount.')}
        {toggle('allow_split', 'Allow splitting', 'One item split across up to three products when one is short.')}
      </section>
      <section className="card">
        <h2><span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><Icon name="lock" />Always a human</span></h2>
        <p className="muted small" style={{ marginTop: 4 }}>Hard rules. No setting changes them.</p>
        <ul className="locked">
          {['Allergen and diet limits', 'Alcohol', 'Quantity not fully covered', 'Late delivery', 'Cached prices (API trouble)', 'Over the request budget'].map((x) => (
            <li key={x}><Icon name="lock" size={14} />{x}</li>
          ))}
        </ul>
      </section>
      {approver && (
        <div className="savebar">
          <span className="grow">{dirty ? 'Unsaved changes' : 'All changes saved'}</span>
          <button className="btn ghost" disabled={!dirty} onClick={() => { setPol(saved); setFromTrust(false); }}>Discard</button>
          <button className="btn primary" disabled={!dirty} onClick={save}>Save policy</button>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
