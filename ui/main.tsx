// Ordering UI (context.md §11.2). One path for every order: ask → agent plans → you check → approve → send to webshop.
// Every check, limit and choice is explained in plain words where it appears.
import { StrictMode, useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral';

// One person runs each kitchen (the owner); the AI agent works with its own, limited key. The owner's session token
// stays in this browser; `demo-owner` is the shared demo kitchen, offered only when the server is not hosted.
const TOKEN_KEY = 'earnest-token';
const storedToken = () => { try { return localStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; } };
const storeToken = (t: string) => { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* private window: this tab only */ } };

// Labels for the planner's flags. Codes never reach the screen; `help` is shown next to the label where it appears.
const FLAGS: Record<string, { label: string; tone: Tone; help: string }> = {
  E1: { label: 'No match', tone: 'bad', help: 'No product passed your limits for this item.' },
  E2: { label: 'Some can’t be delivered', tone: 'neutral', help: 'Valio cannot deliver some matching products. They were left out; similar ones are suggested.' },
  E3: { label: 'Arrives late', tone: 'warn', help: 'Arrives after your date, so it would come in a separate, later delivery.' },
  E4: { label: 'Split across products', tone: 'info', help: 'One product alone does not cover the quantity, so it is split across up to three.' },
  E5: { label: 'Delivery not confirmed', tone: 'warn', help: 'Valio accepts the order but does not confirm stock for this product. It will most likely arrive, but it is not guaranteed.' },
  E6: { label: 'Some order deadlines passed', tone: 'neutral', help: 'For some products the order deadline for this date has passed. They were left out.' },
  E7: { label: 'Some without price', tone: 'neutral', help: 'Valio returned no price for some products. They were left out.' },
  E8: { label: 'Allergen info missing', tone: 'neutral', help: 'Some products have no allergen information. With your limits they were left out, to be safe.' },
  E9: { label: 'Saved prices used', tone: 'bad', help: 'Valio’s price service did not answer. Prices recorded earlier were used; they are checked again on approval.' },
  content_from_price: { label: 'Pack size from price', tone: 'info', help: 'The product data has no pack size, so it was worked out from Valio’s price per litre or kilo.' },
  content_mismatch: { label: 'Pack size corrected', tone: 'info', help: 'Product data and Valio disagreed on the pack size. Valio’s value is used.' },
  litre_as_kg: { label: 'Litres counted as kilos', tone: 'info', help: 'The recipe weighs this liquid; the product is sold by the litre. 1 l is counted as 1 kg.' },
};

// Every policy check: its name, why it exists, and what the person can do about it.
const RULES: Record<string, { label: string; why: string; fix?: string }> = {
  allergen_and_diet_limits: { label: 'Allergens and diets', why: 'No line may break the allergen or diet limits of the request. A product without allergen information counts as breaking them.', fix: 'Choose another product for that item.' },
  alcohol_needs_human: { label: 'Alcohol', why: 'Licences and quotas apply to alcohol, so a person always checks it.' },
  need_covered: { label: 'Full quantity', why: 'Part of an item has no product that can be delivered. A person decides whether a partial order is fine.', fix: 'Try a later delivery date, or accept the smaller amount.' },
  on_time: { label: 'Arrives on time', why: 'Some lines arrive after your date and would come in a separate, later delivery.', fix: 'Choose another product, or accept the later delivery.' },
  live_prices: { label: 'Live prices', why: 'Valio’s price service did not answer, so prices saved earlier were used.', fix: 'Approving re-checks every price with Valio first.' },
  request_budget: { label: 'Budget', why: 'The order costs more than the budget given in the request.' },
  matches_request_text: { label: 'Matches your words', why: 'A quantity in the order is not a number from the original request. A misread 100 as 1000 looks plausible, so a person confirms.', fix: 'Check the quantity against the request at the top.' },
  usual_quantity: { label: 'Usual amount', why: 'The amount is far from what this kitchen usually orders. That is often a typo.', fix: 'Check the amount; change it on the item if needed.' },
  agent_may_finalise: { label: 'Who signs off', why: 'Your policy says a person signs off every order.', fix: 'You can let the agent finish small, routine orders in Policy.' },
  max_order_eur: { label: 'Order limit', why: 'Orders above this total need a person, by your policy.', fix: 'Change the limit in Policy.' },
  max_line_eur: { label: 'Line limit', why: 'A single line above this amount needs a person, by your policy.', fix: 'Change the limit in Policy.' },
  confirmed_stock: { label: 'Delivery guarantee', why: 'Valio reports no stock amount for a line: it can be ordered and will most likely arrive, but the amount is not confirmed. Your policy asks you to look.', fix: 'Use the sure-delivery option on the item, accept it yourself, or allow it in Policy.' },
  routine_order: { label: 'Routine order', why: 'The agent finishes orders on its own only for products this kitchen has ordered and approved at least 3 times.', fix: 'Approve it yourself; after 3 approvals, similar orders can go through on their own.' },
  allow_split: { label: 'Splitting', why: 'An item is split across products, and your policy wants a person to see that.' },
  max_over_best_price_pct: { label: 'Price vs. cheapest', why: 'A line costs more per litre or kilo than the cheapest suitable product, by more than your policy allows.', fix: 'Choose the cheaper option, or accept the price.' },
  policy_engine: { label: 'Policy check', why: 'The checks could not run, so nothing goes through without a person.' },
};

const STATUS: Record<string, { label: string; tone: Tone }> = {
  needs_review: { label: 'Waiting for decision', tone: 'warn' }, auto_approved: { label: 'Finished by the agent', tone: 'info' },
  approved: { label: 'Approved', tone: 'ok' }, exported: { label: 'Sent to webshop', tone: 'neutral' },
  rejected: { label: 'Rejected', tone: 'bad' }, expired: { label: 'Expired', tone: 'bad' },
};
const CRITERIA = [['price', 'Price'], ['availability', 'Stock'], ['reliability', 'Reliability'], ['co2', 'CO₂'], ['origin', 'Finnish']] as const;
// Two requests that show the product well: the brief's own milk sentence, and cheese with a sure-delivery option.
const EXAMPLES = [
  { icon: 'milk', title: 'Milk for the week', text: 'I need 1,000 litres of lactose-free milk by Monday, best on price and availability.' },
  { icon: 'cheese', title: 'Cheese for pizza night', text: '20 kg of grated cheese for pizza by Wednesday' },
];
const DIETS = [['lactose_free', 'Lactose-free'], ['gluten_free', 'Gluten-free'], ['vegan', 'Vegan'], ['vegetarian', 'Vegetarian']] as const;
const GS1: Record<string, string> = { AM: 'milk', AW: 'gluten', AE: 'egg', AN: 'tree nuts', AP: 'peanuts', AF: 'fish', AC: 'crustaceans', AY: 'soy', AS: 'sesame', BC: 'celery', BM: 'mustard', AU: 'sulphites', NL: 'lupin', UM: 'molluscs' };
const PRIORITIES: Record<string, string> = { price_and_availability: 'Price and stock', sustainability: 'Sustainability', reliability_first: 'Reliable delivery' };

const eur = (c: number | null | undefined) => (c == null ? '–' : (c / 100).toLocaleString('en-IE', { style: 'currency', currency: 'EUR' }));
const num = (n: number) => n.toLocaleString('en-GB', { maximumFractionDigits: 3 });
const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const clock = (s: string) => new Date(s).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const ago = (s: string) => {
  const m = Math.round((Date.now() - Date.parse(s)) / 60000), rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  return m < 1 ? 'just now' : m < 60 ? rtf.format(-m, 'minute') : m < 1440 ? rtf.format(-Math.round(m / 60), 'hour') : rtf.format(-Math.round(m / 1440), 'day');
};
const who = (actor: string) => {
  const [role, ...name] = actor.split(':');
  return role === 'agent' ? `${name.join(':')} (AI agent)` : name.join(':');
};
const unitLabel = (u: string) => (u === 'pcs' ? 'pcs' : u);
const plural = (n: number, w: string) => `${num(n)} ${w}${n === 1 ? '' : 's'}`;
// Server texts name products by id; people know them by name.
// The planner's reasons carry flag codes for agents; people get the words only.
const plain = (text: string) => text.replace(/\s*\((?:E\d|E\d, ?E\d)\)/g, '');
const named = (text: string, names: Map<string, string>) => text.replace(/\b\d{6}\b/g, (id) => names.get(id) ?? id);
const limitLabel = (k: string) => DIETS.find(([d]) => d === k)?.[1] ?? `No ${GS1[k] ?? k}`;

class ApiError extends Error { constructor(message: string, public body: any) { super(message); } }
async function api(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`/api${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  const j = await res.json().catch(() => ({}));
  // A session that ended (signed out elsewhere, server reset): back to the sign-in screen.
  if (res.status === 401 && token) { storeToken(''); location.reload(); }
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
  text: 'M4 6h16M4 12h16M4 18h10', edit: 'M4 20h4L19 9l-4-4L4 16v4Zm9-13 4 4', info: 'M12 16v-5m0-3h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7', box: 'M21 8 12 3 3 8v8l9 5 9-5V8ZM3 8l9 5 9-5M12 13v8',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Zm7 9a7 7 0 0 1-14 0m7 7v3', stop: 'M7 7h10v10H7z',
  milk: 'M9 2h6M9 2v3L7 8v12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V8l-2-3V2M7 12h10',
  cheese: 'M3 18V11.5L15 5l6 6.5V18Zm0-6.5h18M8 15h.01M13 14.5h.01M17 15.5h.01',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-9-9h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9Z',
};
function Icon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}><path d={PATHS[name]} /></svg>
  );
}
const Badge = ({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) => <span className={`badge tone-${tone}`}>{children}</span>;
const Status = ({ s }: { s: string }) => <Badge tone={STATUS[s]?.tone}>{STATUS[s]?.label ?? s}</Badge>;
const Callout = ({ tone, icon = 'alert', title, children }: { tone: Tone; icon?: string; title?: string; children?: ReactNode }) => (
  <div className={`callout tone-${tone}`} role={tone === 'bad' ? 'alert' : undefined}>
    <Icon name={icon} size={18} /><div className="callout-body">{title && <strong>{title}</strong>}{children}</div>
  </div>
);
const Loading = () => <div className="panel" aria-busy="true"><div className="skeleton" style={{ width: '40%' }} /><div className="skeleton" /><div className="skeleton" style={{ width: '70%' }} /></div>;
/** Flags with their meaning spelled out, for the places where a label alone would be a riddle. */
function FlagList({ codes }: { codes: string[] }) {
  const known = [...new Set(codes)].filter((c) => FLAGS[c]);
  if (!known.length) return null;
  return (
    <ul className="flaglist">{known.map((c) => (
      <li key={c} className={`tone-${FLAGS[c].tone}`}><Badge tone={FLAGS[c].tone}>{FLAGS[c].label}</Badge><span>{FLAGS[c].help}</span></li>
    ))}</ul>
  );
}

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
  return <div className="toasts" role="status" aria-live="polite">{items.map((t) => <div key={t.id} className={`toast tone-${t.tone}`}><Icon name="check" />{t.text}</div>)}</div>;
}

// Native <dialog>: focus trap, Esc and the backdrop come with the platform.
function Modal({ open, onClose, label, children }: { open: boolean; onClose: () => void; label: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (open && d && !d.open) { d.showModal(); d.querySelector<HTMLElement>('[data-autofocus]')?.focus(); } // the main action, not the ×
    if (!open && d?.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="modal" aria-label={label} onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <button className="modal-x" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
      {children}
    </dialog>
  );
}

// Orders the agent finished on its own pop up wherever the person is: autonomy is only trusted when it is visible.
function AgentFinished({ rows }: { rows: any[] | null }) {
  const [seen, setSeen] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem('seen-auto') ?? '[]'); } catch { return []; } });
  const fresh = (rows ?? []).filter((r) => !r.requires_human && r.created_by.startsWith('agent:') && ['auto_approved', 'exported'].includes(r.status) && !seen.includes(r.id));
  const close = () => {
    const next = [...seen, ...fresh.map((r) => r.id)].slice(-200);
    setSeen(next);
    try { localStorage.setItem('seen-auto', JSON.stringify(next)); } catch { /* private mode: it shows again next time */ }
  };
  return (
    <Modal open={fresh.length > 0} onClose={close} label="Orders the agent finished">
      <div className="modal-mark"><Icon name="check" size={30} /></div>
      <h2>The agent finished {fresh.length === 1 ? 'an order' : `${fresh.length} orders`} on its own</h2>
      <p className="muted">Every check passed and your policy allows it for routine orders.</p>
      <ul className="modal-list">{fresh.map((r) => (
        <li key={r.id}>
          <a href={`#/p/${r.id}`} onClick={close}>{r.recipe ?? r.needs.map((n: string) => n.replace(/^[\d.]+/, (x) => num(+x))).join(', ')}</a>
          <span className="num">{eur(r.total_cents)}</span>
          <span className="muted small">{r.status === 'exported' ? 'Sent to the webshop' : 'Ready to send'}, delivery {day(r.deliver_by)}</span>
        </li>
      ))}</ul>
      <p className="small muted">You can still reject an order that has not been sent. Rejecting it also switches the agent’s autonomy off.</p>
      <button className="btn lime block" data-autofocus onClick={close}>Got it</button>
    </Modal>
  );
}

// ---------- Sign in ----------
function App() {
  const [token, setToken] = useState(storedToken);
  const use = (t: string) => { storeToken(t); setToken(t); };
  if (!token) return <><Auth onToken={use} /><Toasts /></>;
  const signOut = () => api(token, 'POST', '/auth/logout').catch(() => null).finally(() => { location.hash = ''; use(''); });
  return <Shell key={token} token={token} signOut={signOut} />;
}

function Auth({ onToken }: { onToken: (token: string) => void }) {
  const [cfg, setCfg] = useState<{ invite_required?: boolean; demo_kitchen?: boolean } | null>(null);
  const [mode, setMode] = useState<'up' | 'in'>('up');
  const [f, setF] = useState({ name: '', email: '', password: '', invite: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { api('', 'GET', '/auth/config').then(setCfg, () => setCfg({})); }, []);
  const set = (k: keyof typeof f) => (e: ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const r = await api('', 'POST', mode === 'up' ? '/auth/register' : '/auth/login', mode === 'up' ? f : { email: f.email, password: f.password });
      onToken(r.token);
    } catch (x) {
      const m = (x as Error).message;
      setErr(m === 'invalid request' ? 'Check the fields: a valid email, and a password of at least 8 characters.' : m);
      setBusy(false);
    }
  };
  const up = mode === 'up';
  return (
    <main id="main" className="auth">
      <div className="panel auth-card">
        <span className="brand">
          <span className="brand-mark"><Icon name="shield" size={18} /></span>
          <span className="brand-name">Earnest<small>trust isn't given, it's earned</small></span>
        </span>
        <p className="muted">A purchasing agent for Valio Aimo that earns your trust one approved order at a time.
          {up && ' Your account comes with a kitchen of its own: Hotel Kaisla, with two milk orders you approved before.'}</p>
        <div className="segmented" role="group" aria-label="Account">
          <button type="button" aria-pressed={up} onClick={() => { setMode('up'); setErr(''); }}>Create account</button>
          <button type="button" aria-pressed={!up} onClick={() => { setMode('in'); setErr(''); }}>Sign in</button>
        </div>
        <form onSubmit={submit}>
          {up && <div className="field"><label htmlFor="a-name">Your name</label><input id="a-name" required autoComplete="name" value={f.name} onChange={set('name')} /></div>}
          <div className="field"><label htmlFor="a-email">Email</label><input id="a-email" type="email" required autoComplete="email" value={f.email} onChange={set('email')} /></div>
          <div className="field"><label htmlFor="a-pw">Password</label><input id="a-pw" type="password" required minLength={8} autoComplete={up ? 'new-password' : 'current-password'} value={f.password} onChange={set('password')} /></div>
          {up && cfg?.invite_required && <div className="field"><label htmlFor="a-invite">Invite code</label><input id="a-invite" required autoComplete="off" value={f.invite} onChange={set('invite')} /></div>}
          {err && <Callout tone="bad">{err}</Callout>}
          <button className="btn lime block" disabled={busy} aria-busy={busy}>
            {busy ? <><Icon name="loader" className="spin" />{up ? 'Setting up your kitchen…' : 'Signing in…'}</> : up ? 'Create account' : 'Sign in'}
          </button>
        </form>
        {cfg?.demo_kitchen && <button type="button" className="btn quiet block" onClick={() => onToken('demo-owner')}>Use the demo kitchen</button>}
      </div>
    </main>
  );
}

// ---------- Shell ----------
function Shell({ token, signOut }: { token: string; signOut: () => void }) {
  const [me, setMe] = useState<{ name: string } | null>(null);
  useEffect(() => { api(token, 'GET', '/me').then(setMe, () => null); }, [token]);
  const hash = useHash();
  const rows = usePoll<any[]>(() => api(token, 'GET', '/proposals'), 5000, [token]);
  const waiting = rows?.filter((r) => r.status === 'needs_review').length ?? 0;
  const id = hash.match(/^#\/p\/(.+)$/)?.[1];
  const recipe = hash.match(/^#\/recipes\/(.+)$/)?.[1];
  const page = id ? 'proposal' : recipe ? 'recipe' : hash.startsWith('#/recipes') ? 'recipes' : hash.startsWith('#/new') ? 'new' : hash.startsWith('#/stock') ? 'stock' : hash.startsWith('#/policy') ? 'policy' : 'home';
  const here = (p: string[]) => (p.includes(page) ? 'page' : undefined);
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <div className="utility">
        <div className="wrap">
          <span><Icon name="pin" size={14} />Hotel Kaisla, Helsinki</span>
          <span><Icon name="user" size={14} />Signed in as {me?.name ?? '…'}<button type="button" className="signout" onClick={signOut}>Sign out</button></span>
        </div>
      </div>
      <header className="masthead">
        <div className="wrap">
          <a href="#" className="brand" aria-label="Earnest, home">
            <span className="brand-mark"><Icon name="shield" size={18} /></span>
            <span className="brand-name">Earnest<small>trust isn't given, it's earned</small></span>
          </a>
          <nav className="nav" aria-label="Main">
            <a href="#" aria-current={here(['home', 'proposal'])}>Orders{waiting > 0 && <span className="count" aria-label={`${waiting} waiting for a decision`}>{waiting}</span>}</a>
            <a href="#/recipes" aria-current={here(['recipes', 'recipe'])}>Recipes</a>
            <a href="#/stock" aria-current={here(['stock'])}>Stock</a>
            <a href="#/policy" aria-current={here(['policy'])}>Policy</a>
          </nav>
          <a className="btn lime" href="#/new"><Icon name="plus" />New order</a>
        </div>
      </header>
      <main id="main">
        {page === 'proposal' ? <Proposal key={id} id={id!} token={token} />
          : page === 'new' ? <NewOrder token={token} />
          : page === 'recipes' ? <Recipes token={token} />
          : page === 'recipe' ? <RecipePage key={recipe} id={recipe!} token={token} />
          : page === 'stock' ? <Stock token={token} />
          : page === 'policy' ? <Policy key={hash + token} token={token} suggest={hash.endsWith('?suggest')} />
          : <Home rows={rows} token={token} />}
      </main>
      <AgentFinished rows={rows} />
      <Toasts />
    </>
  );
}

// ---------- Home ----------
function Home({ rows, token }: { rows: any[] | null; token: string }) {
  const waiting = rows?.filter((r) => r.status === 'needs_review') ?? [];
  const ready = rows?.filter((r) => ['approved', 'auto_approved'].includes(r.status)) ?? [];
  const done = rows?.filter((r) => ['exported', 'rejected', 'expired'].includes(r.status)) ?? [];
  return (
    <div className="wrap page">
      <section className="start" aria-labelledby="start-h">
        <div>
          <h1 id="start-h">What does the kitchen need?</h1>
          <p className="lead">Tell the agent in your own words, or pick a recipe. It finds the products, checks Valio’s live prices and stock, and prepares an order. Nothing is ordered until a person approves it.</p>
        </div>
        <div className="start-actions">
          <a className="start-tile" href="#/new">
            <Icon name="text" size={22} />
            <strong>Describe what you need</strong>
            <span>“1,000 litres of lactose-free milk by Monday”</span>
          </a>
          <a className="start-tile" href="#/recipes">
            <Icon name="book" size={22} />
            <strong>Order for a recipe</strong>
            <span>Pick a dish and the number of portions</span>
          </a>
        </div>
      </section>

      <ol className="promise" aria-label="How your orders stay safe">
        <li><strong>The agent never orders alone.</strong><span>It prepares a proposal. A person approves it, unless your policy lets small routine orders through.</span></li>
        <li><strong>Every choice has a reason.</strong><span>Each line says why that product: price, stock, delivery date. Every check is listed.</span></li>
        <li><strong>Prices are checked again.</strong><span>Approving re-checks prices and stock with Valio. If anything changed, you see what.</span></li>
      </ol>

      <TrustBanner token={token} />

      {!rows ? <Loading /> : <>
        <section className="group" aria-labelledby="g-wait">
          <div className="group-head">
            <h2 id="g-wait">Waiting for your decision</h2>
            <span className="muted">{waiting.length || 'None'}</span>
          </div>
          {!waiting.length ? <p className="empty-line"><Icon name="check" />Nothing waiting. New proposals that need a person appear here.</p>
            : <ul className="orders">{waiting.map((r) => <OrderRow key={r.id} r={r} />)}</ul>}
        </section>
        {!!ready.length && (
          <section className="group" aria-labelledby="g-ready">
            <div className="group-head"><h2 id="g-ready">Ready to send to the webshop</h2><span className="muted">{ready.length}</span></div>
            <ul className="orders">{ready.map((r) => <OrderRow key={r.id} r={r} />)}</ul>
          </section>
        )}
        {!!done.length && (
          <details className="group done">
            <summary><h2>Finished</h2><span className="muted">{done.length}</span></summary>
            <ul className="orders">{done.map((r) => <OrderRow key={r.id} r={r} />)}</ul>
          </details>
        )}
      </>}
    </div>
  );
}

function OrderRow({ r }: { r: any }) {
  const checks: string[] = r.open_checks ?? [];
  return (
    <li>
      <a className="order" href={`#/p/${r.id}`}>
        <div className="order-main">
          <strong>{r.recipe ?? r.needs.map((n: string) => n.replace(/^[\d.]+/, (x) => num(+x))).join(', ')}</strong>
          <span className="muted small">{r.recipe ? `${r.needs.length} ingredients, ` : ''}by {day(r.deliver_by)}, {r.from_stock ? 'stock refill by' : 'from'} {who(r.created_by)}, {ago(r.created_at)}</span>
          {r.status === 'needs_review' && !!checks.length && (
            <span className="reasons">{checks.slice(0, 4).map((c) => <span key={c}>{RULES[c]?.label ?? c}</span>)}{checks.length > 4 && <span>+{checks.length - 4}</span>}</span>
          )}
        </div>
        <div className="order-side">
          <span className="order-total num">{eur(r.total_cents)}</span>
          <Status s={r.status} />
        </div>
      </a>
    </li>
  );
}

// The kitchen's own stock system (a mock in the demo): what runs low, and one button for the agent to refill it.
const lasts = (d: number) => (d < 1 ? 'less than a day' : `${num(Math.floor(d))} day${Math.floor(d) === 1 ? '' : 's'}`);
function Stock({ token }: { token: string }) {
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const s = usePoll<any>(() => api(token, 'GET', '/stock'), 5000, [token, tick]);
  if (!s) return <div className="wrap page"><Loading /></div>;
  const low = s.items.filter((i: any) => i.low);
  const check = async () => {
    setBusy(true);
    try {
      const { created } = await api(token, 'POST', '/stock/check');
      toast(created.length ? `The agent proposed ${plural(created.length, 'refill')}. Find them under Orders.` : 'Nothing runs low. No order needed.');
    } catch (e) { toast((e as Error).message, 'bad'); }
    setTick((t) => t + 1); setBusy(false);
  };
  return (
    <div className="wrap page">
    <h1>Kitchen stock</h1>
    <p className="lead">The agent reads your stock levels. Anything that runs out within {s.low_days} days gets a refill proposal, up to your usual level. A refill is an ordinary order: same checks, same approval.</p>
    <section className="panel stock" aria-label="Stock levels">
      <div className="panel-head">
        <h2>Stock levels</h2>
        <span className="muted small">{s.system}, read {clock(s.read_at)}</span>
      </div>
      <ul className="stock-list">{s.items.map((i: any) => {
        const d = i.on_hand / i.daily_use, u = unitLabel(i.unit);
        return (
          <li key={i.need}>
            <div className="stock-name"><strong>{i.name}</strong><span className="muted small">{num(i.on_hand)} {u} left, about {num(i.daily_use)} {u} a day</span></div>
            <div className="stock-bar" aria-hidden="true"><span className={d < s.low_days ? 'low' : ''} style={{ width: `${Math.min(100, d * 10)}%` }} /></div>
            <span className="small num stock-lasts">lasts {lasts(d)}</span>
            {i.orders.length ? <a className="badge tone-info" href={`#/p/${i.orders[0]}`}>Refill on the way</a>
              : i.low ? <Badge tone="warn">Running low</Badge> : <Badge tone="ok">Enough</Badge>}
          </li>
        );
      })}</ul>
      <div className="stock-foot">
        <button className="btn" disabled={busy || !low.length} aria-busy={busy} onClick={check}>
          {busy ? <><Icon name="loader" className="spin" />The agent is planning…</>
            : low.length ? <><Icon name="spark" />Let the agent refill {plural(low.length, 'item')}</> : <><Icon name="check" />Nothing to refill</>}
        </button>
      </div>
    </section>
    </div>
  );
}

// §8.4: a suggestion only; the owner reviews the values and saves the policy themselves.
function TrustBanner({ token }: { token: string }) {
  const [t, setT] = useState<any>(null);
  useEffect(() => { api(token, 'GET', '/trust').then(setT, () => setT(null)); }, [token]);
  if (!t?.suggestion) return null;
  return (
    <div className="callout tone-ok trust">
      <Icon name="spark" size={18} />
      <div className="callout-body"><strong>Your approvals are building trust</strong><p>{t.suggestion.text} Nothing changes until you save it.</p></div>
      <a className="btn" href="#/policy?suggest">Review the suggestion</a>
    </div>
  );
}

// ---------- The path ----------
type StepState = 'done' | 'now' | 'next' | 'stop';
type Step = { state: StepState; note?: string };
// The one path every order takes. Every screen of it shows the same band with the same steps.
const PATH = ['Ask', 'Agent plans', 'Confirm', 'You check', 'Approve', 'Send to webshop'];
const NOTES = ['what you need', 'products, prices, stock', 'is this what you meant?', 'checks and limits', 'prices re-checked first', 'import file'];
/** Before a proposal exists: `at` = 0 asking, 1 the agent is planning. */
const earlySteps = (at: number, notes: Partial<Record<number, string>> = {}): Step[] =>
  PATH.map((_, i) => ({ state: i < at ? 'done' : i === at ? 'now' : 'next', note: notes[i] ?? NOTES[i] }));
function proposalSteps(p: any, open: number): Step[] {
  const s = p.status, r = p.request, c = p.confirmation;
  return [
    { state: 'done', note: r.recipe ? 'a recipe' : r.stock ? 'stock running low' : r.source_text ? 'in your words' : 'by form or agent' },
    { state: 'done', note: plural(p.items.reduce((n: number, it: any) => n + it.allocation.length, 0), 'line') },
    { state: c.required ? 'now' : 'done', note: c.required ? (r.stock ? 'do you need this?' : 'is this what you meant?') : c.done ? 'you confirmed' : c.skipped_by_trust ? 'skipped: trusted' : 'not needed' },
    { state: s === 'needs_review' ? (c.required ? 'next' : 'now') : 'done', note: s !== 'needs_review' || !open ? 'all clear' : `${open} thing${open === 1 ? '' : 's'} to look at` },
    { state: ['rejected', 'expired'].includes(s) ? 'stop' : s === 'needs_review' ? 'next' : 'done',
      note: s === 'rejected' ? 'rejected' : s === 'expired' ? 'expired' : s === 'auto_approved' ? 'by the agent, within policy' : s === 'needs_review' ? NOTES[4] : 'approved' },
    { state: s === 'exported' ? 'done' : ['approved', 'auto_approved'].includes(s) ? 'now' : 'next', note: s === 'exported' ? 'file downloaded' : NOTES[5] },
  ];
}
function Steps({ steps }: { steps: Step[] }) {
  return (
    <ol className="steps" aria-label="Order progress">
      {steps.map((x, i) => (
        <li key={PATH[i]} className={`step ${x.state}`} aria-current={x.state === 'now' ? 'step' : undefined}>
          <span className="step-dot" aria-hidden="true">{x.state === 'done' ? <Icon name="check" size={14} /> : x.state === 'stop' ? <Icon name="x" size={14} /> : i + 1}</span>
          <span className="step-text"><strong>{PATH[i]}</strong><span>{x.note}</span></span>
        </li>
      ))}
    </ol>
  );
}
function Band({ back, title, meta, steps }: { back: [string, string]; title: string; meta?: ReactNode; steps: Step[] }) {
  return (
    <section className="band">
      <div className="wrap">
        <a href={back[0]} className="back"><Icon name="back" />{back[1]}</a>
        <h1>{title}</h1>
        {meta && <p className="band-meta">{meta}</p>}
        <Steps steps={steps} />
      </div>
    </section>
  );
}

// ---------- Proposal ----------
function Proposal({ id, token }: { id: string; token: string }) {
  const [p, setP] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [diffs, setDiffs] = useState<any[] | null>(null);
  const [note, setNote] = useState('');
  const [done, setDone] = useState<'approved' | 'sent' | null>(null);
  const load = useCallback(() => Promise.all([api(token, 'GET', `/proposals/${id}`), api(token, 'GET', `/audit?proposal=${id}`)])
    .then(([p, e]) => { setP(p); setEvents(e); }, (e) => setErr(e.message)), [id, token]);
  useEffect(() => { load(); }, [load]);
  const act = async (label: string, fn: () => Promise<unknown>, message?: string) => {
    setBusy(label); setErr(''); setDiffs(null);
    let ok = false;
    try { await fn(); ok = true; if (message) toast(message); } catch (e) { setErr((e as Error).message); setDiffs((e as ApiError).body?.diffs ?? null); }
    await load(); setBusy(null);
    return ok;
  };
  const exportFile = async () => { if (await act('export', () => download(token, id))) setDone('sent'); };
  const fx: Fixes = {
    confirm: () => { act('confirm', () => api(token, 'POST', `/proposals/${id}/confirm`), 'Confirmed. Now check the order and approve it.'); },
    correct: (fix) => act('correct', () => api(token, 'PATCH', `/proposals/${id}/request`, fix), 'Corrected. The agent planned the order again.'),
    busy: !!busy, open: false,
  };
  const revise = (item: number, rev: object) => act('revise', () => api(token, 'PATCH', `/proposals/${id}`, { item, ...rev }), 'Updated. Every check ran again.');
  const decide = (decision: 'approve' | 'reject') => {
    if (decision === 'reject' && !confirm('Reject this proposal? Nothing will be ordered.')) return;
    act(decision, () => api(token, 'POST', `/proposals/${id}/decision`, { decision, note: note || undefined }),
      decision === 'reject' ? 'Rejected. Nothing will be ordered.' : undefined).then((ok) => { if (ok && decision === 'approve') setDone('approved'); });
  };

  if (!p) return <div className="wrap page">{err ? <Callout tone="bad" title="This proposal could not be loaded">{err}</Callout> : <Loading />}</div>;
  const open = ['needs_review', 'auto_approved'].includes(p.status);
  const failed = p.policy_verdict.rules.filter((r: any) => !r.ok);
  const rc = p.request.recipe;
  const title = rc ? `${rc.name} for ${num(rc.portions)}` : p.items.map((it: any) => `${num(it.item.quantity)} ${unitLabel(it.item.unit)} ${it.item.need}`).join(', ');
  return (
    <>
      <Band back={['#', 'All orders']} title={title} steps={proposalSteps(p, issuesOf(p, failed, new Map()).length)} meta={<>
        <span><Icon name="truck" size={15} />Deliver by {day(p.deliver_by)}{p.deliver_by_defaulted && ' (next delivery day, none was given)'}</span>
        <span><Icon name="pin" size={15} />{p.site}</span>
        <span><Icon name="user" size={15} />{p.request.stock ? 'Proposed by' : 'Asked by'} {who(p.created_by)}{p.request.stock && ' from your stock system'}, {ago(p.created_at)}</span>
      </>} />

      <div className="wrap page proposal-grid">
        <div className="main-col">
          {err && !diffs && <Callout tone="bad" title="That did not go through">{err}</Callout>}
          {diffs && (
            <Callout tone="warn" title="Valio’s offers changed since the agent planned this">
              <ul>{diffs.map((d, i) => <li key={i}>{p.items.flatMap((it: any) => it.allocation).find((a: any) => a.id === d.id)?.name ?? `#${d.id}`}: {d.what.replace(/_/g, ' ')} {String(d.before)} → {String(d.after)}</li>)}</ul>
              <p>The lines below show the new situation. Look them over and approve again.</p>
            </Callout>
          )}
          <ReadBack p={p} fx={{ ...fx, open }} />
          <h2 className="section-title">The order</h2>
          {p.items.map((it: any, i: number) => <Item key={i} it={it} from={rc?.from[i]} open={open} busy={!!busy} revise={(rev) => revise(i, rev)} />)}
          <Timeline events={events} />
        </div>

        <aside className="rail" aria-label="Your decision">
          <Decision p={p} failed={failed} busy={busy} note={note} setNote={setNote} decide={decide} exportFile={exportFile}
            useSure={open && p.items.some((it: any) => it.sure_option) ? () => act('revise', async () => {
              for (const [i, it] of p.items.entries()) if (it.sure_option) await api(token, 'PATCH', `/proposals/${id}`, { item: i, confirmed_only: true });
            }, 'Switched to sure delivery. Every check ran again.') : undefined} />
        </aside>
      </div>

      <Modal open={!!done} onClose={() => setDone(null)} label={done === 'sent' ? 'Order file ready' : 'Order approved'}>
        <div className="modal-mark"><Icon name={done === 'sent' ? 'download' : 'check'} size={30} /></div>
        {done === 'approved' ? <>
          <h2>Order approved</h2>
          <p><strong>{title}</strong>: {plural(p.items.reduce((n: number, it: any) => n + it.allocation.length, 0), 'line')}, {eur(p.total_cents)}, delivered by {day(p.deliver_by)}.</p>
          <p className="muted">Prices and stock were re-checked with Valio just now. Every line has confirmed stock.</p>
          <div className="modal-next"><strong>Last step:</strong> send it to the webshop.</div>
          <button className="btn lime block" data-autofocus disabled={!!busy} onClick={exportFile}><Icon name="download" />Download webshop file</button>
          <button className="btn quiet block" onClick={() => setDone(null)}>Later</button>
        </> : <>
          <h2>Order file ready</h2>
          <p>The file for <strong>{title}</strong> is in your downloads.</p>
          <ol className="import">
            <li>Open your cart in the Valio Aimo webshop.</li>
            <li>Choose <strong>Tuo tiedostosta</strong> (import from file) and pick the file.</li>
            <li>Check the cart and place the order as usual.</li>
          </ol>
          <a className="btn lime block" href="#" data-autofocus onClick={() => setDone(null)}>Back to all orders</a>
          <button className="btn quiet block" onClick={() => setDone(null)}>Stay here</button>
        </>}
      </Modal>
    </>
  );
}

// The checks a person must look at, in plain words, with what to do about each. Built from the verdict and the
// proposal itself; "Who signs off" is not a problem with an order, so it is a footnote, not a card.
type Issue = { key: string; fixed: boolean; tone: Tone; icon: string; title: string; text: string; why: string; action?: { label: string; run?: () => void; href?: string } };
const toRequest = () => document.getElementById('understood')?.scrollIntoView({ behavior: 'smooth' });
function issuesOf(p: any, failed: any[], names: Map<string, string>, useSure?: () => void): Issue[] {
  const by = new Map(failed.map((r) => [r.rule, r]));
  const list = (ids: string) => named(ids, names).split(', ').join(', ');
  const out: Issue[] = [];
  const why = (k: string) => RULES[k]?.why ?? '';
  const fixed = (k: string, title: string, text: string, icon = 'lock', action?: Issue['action'], tone: Tone = 'bad') =>
    out.push({ key: k, fixed: true, tone, icon, title, text, why: why(k), action });
  for (const r of failed.filter((x) => x.hard)) {
    const d: string = r.detail;
    if (r.rule === 'usual_quantity') {
      const m = d.match(/: (.+?) ([\d.]+) (\w+), usually ([\d.]+) \w+ \((\d+) past orders\)/);
      if (m) {
        const [, need, q, u, usual, n] = m, x = +q / +usual;
        fixed(r.rule, x >= 1 ? `${num(+q)} ${u} is ${Math.round(x)}× your usual amount` : `${num(+q)} ${u} is far below your usual amount`,
          `You usually order about ${num(+usual)} ${u} of ${need} (${n} past orders). Is it a typo?`, 'alert', { label: 'Check the amount', run: toRequest }, 'warn');
      } else fixed(r.rule, 'Unusual amount', d, 'alert', { label: 'Check the amount', run: toRequest }, 'warn');
    } else if (r.rule === 'matches_request_text') {
      fixed(r.rule, 'An amount is not in your words', `Your request does not say ${d.replace(/^not in the original text: /, '')}. Check it is what you meant.`, 'alert', { label: 'Check the amount', run: toRequest }, 'warn');
    } else if (r.rule === 'need_covered') {
      const parts = d.split('; ').map((x) => x.replace(/: ([\d.]+) of [\d.]+ (\w+) not covered/, ' ($1 $2)'));
      fixed(r.rule, 'Part of the order cannot be delivered', `Nothing can be delivered for ${parts.join(', ')} by this date.`, 'alert', { label: 'Try another date', run: toRequest });
    } else if (r.rule === 'on_time') {
      fixed(r.rule, 'Some lines arrive late', `${list(d.replace(/^late lines go to a later delivery: /, ''))} would come in a later delivery.`, 'truck', undefined, 'warn');
    } else if (r.rule === 'live_prices') {
      fixed(r.rule, 'Prices are from earlier', 'Valio’s price service did not answer, so saved prices are shown. Approving checks them again.', 'alert', undefined, 'warn');
    } else if (r.rule === 'allergen_and_diet_limits') {
      fixed(r.rule, 'A product breaks your diet or allergy limits', `${list(d.replace(/^lines break the limits: /, ''))}. Choose another product.`);
    } else if (r.rule === 'alcohol_needs_human') {
      fixed(r.rule, 'Alcohol always needs your OK', `${list(d.replace(/^alcohol lines always need a human: /, ''))}.`);
    } else fixed(r.rule, RULES[r.rule]?.label ?? r.rule, named(d, names));
  }
  // Spending limits: one card for the order and line limits together.
  const order = by.get('max_order_eur'), line = by.get('max_line_eur');
  if (order || line) {
    const ol = order?.detail.match(/> €(\d+)/)?.[1], ll = line?.detail.match(/over €(\d+)/)?.[1];
    const lineCount = line ? line.detail.replace(/^lines over €\d+: /, '').split(', ').length : 0;
    out.push({ key: 'money', fixed: false, tone: 'warn', icon: 'alert', title: 'Over your spending limits',
      text: [order && `This order is ${eur(p.total_cents)}; your order limit is €${ol}.`, line && `${lineCount === 1 ? 'One line is' : `${lineCount} lines are`} over your €${ll} line limit.`].filter(Boolean).join(' '),
      why: 'You set these limits. Anything above them waits for you, so a large order never goes through unnoticed.', action: { label: 'Change limits', href: '#/policy' } });
  }
  const stock = by.get('confirmed_stock'); // a policy setting (off by default), not a fixed rule
  if (stock) {
    const risky = p.items.filter((it: any) => it.sure_option);
    const extra = risky.reduce((sum: number, it: any) => sum + it.sure_option.extra_cents, 0);
    out.push({ key: 'confirmed_stock', fixed: false, tone: 'warn', icon: 'truck', title: 'Delivery is not confirmed',
      text: `Valio reports no stock amount for ${list(stock.detail.replace(/^stock not confirmed: /, ''))}. It will most likely arrive.`
        + (risky.length ? ` A sure-delivery option costs ${eur(extra)} more.` : ''),
      why: why('confirmed_stock'), action: risky.length && useSure ? { label: 'Use sure delivery', run: useSure } : { label: 'Change in Policy', href: '#/policy' } });
  }
  const soft = (k: string, title: string, text: string, action?: Issue['action']) => { if (by.has(k)) out.push({ key: k, fixed: false, tone: 'warn', icon: 'alert', title, text, why: why(k), action }); };
  const pct = by.get('max_over_best_price_pct')?.detail.match(/more than (\d+) %/)?.[1];
  soft('max_over_best_price_pct', 'Pricier than the cheapest option', `${list((by.get('max_over_best_price_pct')?.detail ?? '').replace(/^.*?: /, ''))}: more than ${pct} % above the cheapest option with confirmed stock.`);
  soft('allow_split', 'Split across products', 'One product does not cover the amount, so the item is split. Your policy asks you to look.', { label: 'Change in Policy', href: '#/policy' });
  soft('routine_order', 'New for the agent', `${(by.get('routine_order')?.detail ?? '').replace(/^.*?: /, '')}: the agent finishes an order alone only after you have approved it 3 times.`);
  for (const r of failed.filter((x) => !x.hard && !['max_order_eur', 'max_line_eur', 'max_over_best_price_pct', 'allow_split', 'routine_order', 'agent_may_finalise', 'confirmed_stock'].includes(x.rule)))
    out.push({ key: r.rule, fixed: false, tone: 'warn', icon: 'alert', title: RULES[r.rule]?.label ?? r.rule, text: named(r.detail, names), why: why(r.rule) });
  return out;
}
function IssueCard({ x, busy }: { x: Issue; busy: boolean }) {
  return (
    <li className={`issue tone-${x.tone}`}>
      <div className="issue-head">
        <Icon name={x.icon} />
        <strong>{x.title}</strong>
        <span className="issue-tag">{x.fixed ? <><Icon name="lock" size={11} />Fixed rule</> : 'Your limit'}</span>
      </div>
      <p>{x.text}</p>
      <div className="issue-foot">
        {x.action?.run && <button className="btn sm" disabled={busy} onClick={x.action.run}>{x.action.label}</button>}
        {x.action?.href && <a className="btn sm" href={x.action.href}>{x.action.label}</a>}
        <details><summary>Why?</summary><p>{x.why}</p></details>
      </div>
    </li>
  );
}

// Top-level on purpose: a component declared inside another is a new type on every render, so React remounts it
// and an open "Why this check" closes whenever the page polls (every 5 s).
function RuleRow({ r, tone, icon, names }: { r: any; tone: Tone; icon: string; names: Map<string, string> }) {
  return (
    <li className={`rule tone-${tone}`}>
      <Icon name={icon} />
      <div>
        <strong>{RULES[r.rule]?.label ?? r.rule}</strong>
        <span className="rule-detail">{named(r.detail, names)}</span>
        {RULES[r.rule] && (
          <details>
            <summary>Why this check</summary>
            <p>{RULES[r.rule].why}</p>
            {!r.ok && RULES[r.rule].fix && <p><strong>What you can do:</strong> {RULES[r.rule].fix}</p>}
          </details>
        )}
      </div>
    </li>
  );
}

function Decision({ p, failed, busy, note, setNote, decide, exportFile, useSure }: {
  p: any; failed: any[]; busy: string | null; note: string; setNote: (s: string) => void;
  decide: (d: 'approve' | 'reject') => void; exportFile: () => void; useSure?: () => void;
}) {
  const s = p.status;
  const passed = p.policy_verdict.rules.filter((r: any) => r.ok);
  const lines = p.items.reduce((n: number, it: any) => n + it.allocation.length, 0);
  const names = new Map<string, string>(p.items.flatMap((it: any) => it.allocation.map((a: any) => [a.id, a.name])));
  const issues = issuesOf(p, failed, names, useSure);
  const signs = failed.some((r) => r.rule === 'agent_may_finalise');
  return (
    <section className="decision">
      <div className="decision-top">
        <Status s={s} />
        <p className="total num">{eur(p.total_cents)}</p>
        <p className="muted small">{plural(lines, 'line')}, excl. VAT, Valio’s prices for {day(p.deliver_by)}</p>
      </div>

      <div className="decision-checks">
        {s === 'needs_review' && <>
          <h2>{issues.length ? `Look at ${issues.length === 1 ? 'one thing' : `${issues.length} things`} before you approve` : 'Nothing looks off'}</h2>
          {!!issues.length && <ul className="issues">{issues.map((x) => <IssueCard key={x.key} x={x} busy={!!busy} />)}</ul>}
          {signs && <p className="signs"><Icon name="user" size={14} /><span>You sign off every order yourself. That is your policy, not a problem with this order. <a href="#/policy">Policy</a></span></p>}
        </>}
        {s === 'auto_approved' && <><h2>Finished by the agent</h2><p className="muted small">Every check passed and the order is routine, so your policy let the agent finish it.</p></>}
        {!!passed.length && (
          <details className="passed">
            <summary><Icon name="check" size={14} />{passed.length} checks passed</summary>
            <ul className="rules">{passed.map((r: any) => <RuleRow key={r.rule} r={r} tone="ok" icon="check" names={names} />)}</ul>
          </details>
        )}
      </div>

      <div className="decision-act">
        {s === 'needs_review' && <>
          <label htmlFor="note">Note for the record <span className="muted">(optional)</span></label>
          <textarea id="note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="e.g. checked the amount with the kitchen" />
          {p.confirmation.required && (
            <p className="locked-note"><Icon name="lock" size={14} /><span>First confirm the request is what you meant. <a href="#understood" onClick={(e) => { e.preventDefault(); document.getElementById('understood')?.scrollIntoView({ behavior: 'smooth' }); }}>Go to the request</a></span></p>
          )}
          <button className="btn lime block" disabled={!!busy || p.confirmation.required} aria-busy={busy === 'approve'} onClick={() => decide('approve')}>
            {busy === 'approve' ? <><Icon name="loader" className="spin" />Re-checking prices with Valio…</> : <><Icon name="check" />Approve order</>}
          </button>
          <p className="act-note">Approving first re-checks every price and stock level with Valio. If anything changed, nothing is approved and you see what changed.</p>
          <button className="btn quiet block" disabled={!!busy} onClick={() => decide('reject')}><Icon name="x" />Reject</button>
        </>}
        {['approved', 'auto_approved', 'exported'].includes(s) && <>
          <button className={`btn block ${s === 'exported' ? '' : 'lime'}`} disabled={!!busy} onClick={exportFile}>
            <Icon name="download" />{s === 'exported' ? 'Download the file again' : 'Download webshop file'}
          </button>
          <ol className="import">
            <li>Open your cart in the Valio Aimo webshop.</li>
            <li>Choose <strong>Tuo tiedostosta</strong> (import from file) and pick the file.</li>
            <li>Check the cart and place the order as usual.</li>
          </ol>
          {s === 'auto_approved' && <button className="btn quiet block" disabled={!!busy} onClick={() => decide('reject')}><Icon name="x" />Reject instead</button>}
        </>}
        {s === 'rejected' && <Callout tone="neutral" icon="x" title="Rejected">Nothing will be ordered. Make a new order if the need is still there.</Callout>}
        {s === 'expired' && <Callout tone="bad" icon="alert" title="Expired">An order deadline passed before approval. Make a new order for a later date.</Callout>}
      </div>
    </section>
  );
}

// Step 2 of the path: what the agent understood, next to the person's own words, with a Fix next to every part
// and one "this is what I meant" before approving. Anything not in their words is called out.
function ReadRow({ tone, title, field, onFix, children }: { tone: Tone; title: string; field?: string; onFix?: (field: string) => void; children?: ReactNode }) {
  return (
    <li className={`tone-${tone}`}>
      <Icon name={tone === 'ok' ? 'check' : tone === 'info' ? 'info' : 'alert'} />
      <div><strong>{title}</strong>{children && <span>{children}</span>}</div>
      {field && onFix && <button className="btn sm quiet fix" onClick={() => onFix(field)}><Icon name="edit" size={13} />Fix</button>}
    </li>
  );
}
type Fixes = { confirm: () => void; correct: (fix: object) => Promise<boolean>; busy: boolean; open: boolean };
function ReadBack({ p, fx }: { p: any; fx: Fixes }) {
  const [editing, setEditing] = useState<string | null>(null);
  const rb = p.read_back, r = p.request, rc = r.recipe, st = r.stock, c = p.confirmation;
  const limits = [...r.diets, ...r.exclude_allergens];
  const fix = fx.open && !editing ? setEditing : undefined;
  const heading = rc ? 'From the recipe' : st ? 'Why the agent ordered' : rb ? 'What the agent understood' : 'What was asked';
  const su = st && unitLabel(r.items[0].unit), refill = st && Math.ceil(st.par - st.on_hand - st.incoming);
  return (
    <section className={`panel understood ${c.required ? 'pending' : ''}`} id="understood" aria-labelledby="understood-h">
      <div className="panel-head">
        <h2 id="understood-h">{heading}</h2>
        {rc && <a className="small" href={rc.url} target="_blank" rel="noreferrer">Original recipe<Icon name="external" size={12} /></a>}
      </div>
      {rc ? <p className="muted">{rc.name} serves {rc.yield}. Scaled to {num(rc.portions)} portions, every amount × {num(rc.portions / rc.yield)}, rounded up to 10 g.</p>
        : st ? <p className="stock-why">Your stock system shows <strong>{num(st.on_hand)} {su} of {st.name.toLowerCase()}</strong> left. The kitchen uses about {num(st.daily_use)} {su} a day, so it lasts {lasts(st.on_hand / st.daily_use)}. The agent refills it to your usual level of {num(st.par)} {su}{st.incoming ? `, counting ${num(st.incoming)} ${su} already on the way` : ''}.</p>
        : rb ? <blockquote>{rb.text}</blockquote>
        : <p className="muted">Entered as a form or by an agent, so there are no original words to compare with.</p>}

      {editing ? <FixForm p={p} focus={editing} fx={fx} close={() => setEditing(null)} /> : (
        <ul className="understood-list">
          {rc ? <ReadRow onFix={fix} tone="ok" title={`${num(rc.portions)} portions`} field="portions">{p.items.length} ingredients to buy</ReadRow>
            : r.items.map((it: any, i: number) => (
              <ReadRow key={i} onFix={fix} tone={!rb || rb.items[i].quantity_in_text ? 'ok' : 'warn'} title={`${num(it.quantity)} ${unitLabel(it.unit)} ${it.need}`} field={`item-${i}`}>
                {st ? (it.quantity === refill ? `${num(st.par)} ${su} usual level − ${num(st.on_hand + st.incoming)} ${su} left` : `You changed it; the agent proposed ${num(refill)} ${su}.`)
                  : !rb ? undefined : !rb.items[i].quantity_in_text ? 'This amount is not in your words. Check it before approving.'
                  : rb.items[i].words ? `You wrote “${rb.items[i].words}”; Finnish product names use “${it.need}”.` : 'As you wrote it.'}
              </ReadRow>
            ))}
          <ReadRow onFix={fix} tone={!rb || rb.deliver_by === 'text' ? 'ok' : 'info'} title={`Deliver by ${day(r.deliver_by)}`} field="date">
            {st ? 'Before the stock runs out.' : r.deliver_by_defaulted ? 'No date was given, so the next delivery day.' : rb?.deliver_by === 'interpreted' ? 'Worked out from your wording.' : rb ? 'As you wrote it.' : undefined}
          </ReadRow>
          {limits.map((k: string) => (
            <ReadRow key={k} onFix={fix} tone={rb?.added_limits.includes(k) ? 'warn' : 'ok'} title={limitLabel(k)} field="limits">
              {rb?.added_limits.includes(k) ? 'Added, not in your words.' : rb ? 'From your words. Every product must meet it.' : 'Every product must meet it.'}
            </ReadRow>
          ))}
          {!limits.length && <ReadRow onFix={fix} tone="info" title="No diets or allergies" field="limits">Add one if any product must meet it.</ReadRow>}
          {!rc && <ReadRow onFix={fix} tone={rb?.priorities_default ? 'info' : 'ok'} title={`Priority: ${PRIORITIES[r.priorities]}`} field="priority">
            {rb?.priorities_default ? 'You named no priority, so price and stock.' : undefined}
          </ReadRow>}
          {rc?.skipped.map((x: any, i: number) => (
            <ReadRow key={`s${i}`} tone="info" title={`Not bought: ${x.text}`}>{
              x.reason === 'usually in stock' ? 'Kitchens usually have it.' : x.reason === 'to taste' ? 'To taste, the recipe gives no amount.' : 'Nothing to buy (water).'}</ReadRow>
          ))}
        </ul>
      )}

      {!editing && fx.open && (
        <div className="confirm-bar">
          {c.done ? <p className="confirmed"><Icon name="check" size={16} />You confirmed this is what you meant{c.done.at && `, ${ago(c.done.at)}`}.</p>
            : c.skipped_by_trust ? <p className="confirmed"><Icon name="spark" size={16} />No need to confirm: you approved {c.threshold} orders in a row without fixes. Fix anything that is off.</p>
            : c.required ? <>
              <p><strong>{st ? 'Do you need this?' : 'Is this what you meant?'}</strong> Confirm it, or fix what is off. Approving stays locked until then.</p>
              <button className="btn lime" disabled={fx.busy} onClick={fx.confirm}><Icon name="check" />{st ? 'Yes, we need this' : 'Yes, this is what I meant'}</button>
            </> : <p className="muted small">The agent finished this order within your policy. Fix anything that is off and it is planned again.</p>}
        </div>
      )}
    </section>
  );
}

/** One small form for every Fix: opens on the part that was clicked, sends only what changed, plans the order again. */
function FixForm({ p, focus, fx, close }: { p: any; focus: string; fx: Fixes; close: () => void }) {
  const r = p.request, rc = r.recipe, rb = p.read_back;
  const [items, setItems] = useState<any[]>(r.items.map((it: any) => ({ need: it.need, quantity: it.quantity, unit: it.unit, ...(it.product ? { product: it.product } : {}) })));
  const [portions, setPortions] = useState<number>(rc?.portions ?? 0);
  const [date, setDate] = useState<string>(r.deliver_by);
  const [diets, setDiets] = useState<string[]>(r.diets);
  const [allergens, setAllergens] = useState<string[]>(r.exclude_allergens);
  const [prio, setPrio] = useState<string>(r.priorities);
  // Limits found in the person's own words always apply (the gateway adds them back), so they are shown locked.
  const fromWords = (k: string) => !!rb && !rb.added_limits.includes(k);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const fix: Record<string, unknown> = {};
    if (rc ? portions !== rc.portions : JSON.stringify(items) !== JSON.stringify(r.items.map((it: any) => ({ need: it.need, quantity: it.quantity, unit: it.unit, ...(it.product ? { product: it.product } : {}) })))) {
      if (rc) fix.portions = portions; else fix.items = items;
    }
    if (date !== r.deliver_by) fix.deliver_by = date;
    if (JSON.stringify(diets) !== JSON.stringify(r.diets)) fix.diets = diets;
    if (JSON.stringify(allergens) !== JSON.stringify(r.exclude_allergens)) fix.exclude_allergens = allergens;
    if (!rc && prio !== r.priorities) fix.priorities = prio;
    if (!Object.keys(fix).length) return close();
    if (await fx.correct(fix)) close();
  };
  const toggle = (xs: string[], x: string) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);
  return (
    <form className="fix-form" onSubmit={save}>
      {rc ? (
        <div className="field"><label htmlFor="fix-portions">Portions</label>
          <input id="fix-portions" type="number" min={1} max={5000} step={1} autoFocus={focus === 'portions'} value={portions} onChange={(e) => setPortions(Math.max(1, Math.round(+e.target.value)))} />
          <span className="hint">{num(portions / rc.yield)} × the recipe</span></div>
      ) : (
        <fieldset>
          <legend>Products</legend>
          {items.map((it, i) => (
            <div key={i} className="item-row">
              <div className="field grow"><label htmlFor={`fix-need-${i}`}>Product</label>
                <input id={`fix-need-${i}`} required value={it.need} autoFocus={focus === `item-${i}`} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, need: e.target.value } : x)))} /></div>
              <div className="field"><label htmlFor={`fix-q-${i}`}>Amount</label>
                <input id={`fix-q-${i}`} type="number" min={0.001} step="any" required value={it.quantity} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, quantity: +e.target.value } : x)))} /></div>
              <div className="field"><label htmlFor={`fix-u-${i}`}>Unit</label>
                <select id={`fix-u-${i}`} value={it.unit} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)))}>
                  <option value="l">litres</option><option value="kg">kg</option><option value="pcs">pieces</option></select></div>
              {items.length > 1 && <button type="button" className="btn quiet icon" aria-label={`Remove ${it.need}`} onClick={() => setItems(items.filter((_, j) => j !== i))}><Icon name="x" /></button>}
            </div>
          ))}
          <button type="button" className="btn sm" onClick={() => setItems([...items, { need: '', quantity: 1, unit: 'kg' }])}><Icon name="plus" size={14} />Add a product</button>
          <p className="hint">Finnish product names match best (maito, kauraleipä).</p>
        </fieldset>
      )}
      <div className="two-col">
        <div className="field"><label htmlFor="fix-date">Deliver by</label>
          <input id="fix-date" type="date" required autoFocus={focus === 'date'} value={date} onChange={(e) => setDate(e.target.value)} /></div>
        {!rc && <div className="field"><label htmlFor="fix-prio">What matters most</label>
          <select id="fix-prio" autoFocus={focus === 'priority'} value={prio} onChange={(e) => setPrio(e.target.value)}>
            {Object.entries(PRIORITIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select></div>}
      </div>
      <fieldset>
        <legend>Diets and allergies</legend>
        <div className="checks-row">
          {DIETS.map(([d, l], i) => (
            <label key={d} className="check-pill">
              <input type="checkbox" autoFocus={focus === 'limits' && i === 0} checked={diets.includes(d)} disabled={diets.includes(d) && fromWords(d)} onChange={() => setDiets(toggle(diets, d))} />{l}
              {diets.includes(d) && fromWords(d) && <Icon name="lock" size={12} />}
            </label>
          ))}
          {Object.entries(GS1).filter(([k]) => ['AM', 'AW', 'AE', 'AN', 'AP', 'AF', 'AY', 'AS'].includes(k)).map(([k, l]) => (
            <label key={k} className="check-pill">
              <input type="checkbox" checked={allergens.includes(k)} disabled={allergens.includes(k) && fromWords(k)} onChange={() => setAllergens(toggle(allergens, k))} />No {l}
              {allergens.includes(k) && fromWords(k) && <Icon name="lock" size={12} />}
            </label>
          ))}
        </div>
        {!!rb && <p className="hint"><Icon name="lock" size={12} /> Found in your words, so always applied.</p>}
      </fieldset>
      <div className="form-foot">
        <button type="button" className="btn quiet" onClick={close}>Cancel</button>
        <button className="btn" disabled={fx.busy} aria-busy={fx.busy}>{fx.busy ? <><Icon name="loader" className="spin" />Planning again…</> : 'Save and plan again'}</button>
      </div>
      <p className="act-note">The agent plans the order again with your correction and every check runs again. A fix counts as a change for the trust count.</p>
    </form>
  );
}

// Turns the planner's computed facts into readable sentences; anything unrecognised is shown as computed.
function fact(f: string) {
  let m;
  if ((m = f.match(/^rank (\d+) of (\d+) with confirmed stock, (\d+) deliverable, score [\d.]+$/)))
    return m[2] === '1' ? `The only one of ${m[3]} options with confirmed stock` : m[1] === '1' ? `Best of the ${m[2]} options with confirmed stock` : `Ranked ${m[1]} of ${m[2]} options with confirmed stock`;
  if ((m = f.match(/^rank (\d+) of (\d+) deliverable, score ([\d.]+)$/))) return m[2] === '1' ? 'The only option that can be delivered' : m[1] === '1' ? `Best overall of ${m[2]} options that can be delivered` : `Ranked ${m[1]} of ${m[2]} options that can be delivered`;
  if ((m = f.match(/^(€[\d.,]+)\/(\w+) \(best( confirmed)? (€[\d.,]+)\/\w+\)$/))) {
    const sure = m[3] ? ' with confirmed stock' : '';
    return m[1] === m[4] ? `${m[1]} per ${m[2]}, the cheapest${sure}` : `${m[1]} per ${m[2]} (cheapest${sure}: ${m[4]})`;
  }
  if (f === 'amount not confirmed') return 'Delivery not confirmed by Valio';
  if ((m = f.match(/^([\d.]+) (\w+) available$/))) return `${num(+m[1])} ${m[2]} in stock, confirmed by Valio`;
  if ((m = f.match(/^delivers (\d{4}-\d{2}-\d{2})$/))) return `Delivered ${day(m[1])}`;
  if ((m = f.match(/^part (\d+) of (\d+), covers ([\d.]+) of ([\d.]+) (\w+)$/))) return `Part ${m[1]} of ${m[2]}: ${num(+m[3])} of ${num(+m[4])} ${m[5]}`;
  if (f === 'named in the request') return 'The product the recipe names';
  if (f === 'chosen by user') return 'Chosen by a person';
  if (f === 'confirmed amounts only') return 'Sure-delivery option';
  return f;
}

function Item({ it, from, open, busy, revise }: { it: any; from?: string; open: boolean; busy: boolean; revise: (rev: object) => void }) {
  const [qty, setQty] = useState(it.item.quantity);
  const [all, setAll] = useState(false);
  const unit = unitLabel(it.item.unit);
  const chosen = new Set(it.allocation.map((a: any) => a.id));
  const mode = it.overrides?.choose ? 'choose' : it.overrides?.confirmed_only ? 'confirmed' : 'best';
  const prices = it.options.map((o: any) => o.unit_price_cents);
  const best = Math.min(...prices), worst = Math.max(...prices);
  const setQuantity = (e: FormEvent) => { e.preventDefault(); if (qty > 0 && qty !== it.item.quantity) revise({ quantity: qty }); };
  const cost = it.allocation.reduce((s: number, a: any) => s + a.cost_cents, 0);
  // Flags about the chosen lines stay in view; flags about products left out belong with the comparison.
  const lineFlags = [...new Set<string>(it.allocation.flatMap((a: any) => a.flags))].filter((c) => FLAGS[c] && c !== 'E4' || (c === 'E4' && it.allocation.length > 1));
  const otherFlags = it.exceptions.filter((c: string) => FLAGS[c] && !lineFlags.includes(c) && c !== 'E1');
  const hid = `item-${it.item.need.replace(/\W+/g, '-')}`;
  return (
    <section className="panel item" aria-labelledby={hid}>
      <div className="item-head">
        <div>
          <h3 id={hid}>{it.item.need} <span className="item-qty">{num(it.item.quantity)} {unit}</span></h3>
          {from && <p className="muted small">{from}</p>}
        </div>
        <span className={`item-cost num ${it.allocation.length ? '' : 'none'}`}>{it.allocation.length ? eur(cost) : 'Not covered'}</span>
      </div>

      {it.named && (
        <p className={`note-line tone-${it.named.used ? 'ok' : 'warn'}`}>
          <Icon name={it.named.used ? 'check' : 'alert'} size={15} />
          <span>{it.named.used ? <>Uses the product the recipe names: <strong>{it.named.name}</strong>.</> : <>The recipe names <strong>{it.named.name}</strong>, but it is not used: {plain(it.named.why ?? '')}.</>}</span>
        </p>
      )}
      {it.errors.map((e: string) => <Callout key={e} tone="bad" title="Valio’s price service had trouble">{e}</Callout>)}
      {it.shortfall > 0 && (() => {
        const why = it.dropped.reduce((m: Record<string, number>, d: any) => { for (const r of d.reasons) m[r] = (m[r] ?? 0) + 1; return m; }, {});
        return (
          <Callout tone="warn" title={`${num(it.shortfall)} of ${num(it.item.quantity)} ${unit} not covered`}>
            {mode === 'confirmed' && it.options.some((o: any) => o.available === null) && <p>Only stock Valio confirms is used. Go back to the best option to include products whose stock is not confirmed.</p>}
            {!it.options.length && !!it.dropped.length && <p>Nothing matching “{it.item.need}” can be delivered by this date ({Object.entries(why).map(([r, n]) => `${n} × ${plain(r)}`).join(', ')}). A later delivery date may help.</p>}
            {!it.options.length && !it.dropped.length && <p>No product matched “{it.item.need}” within your limits. Try another word; Finnish product names match best.</p>}
          </Callout>
        );
      })()}

      {!!it.allocation.length && (
        <ul className="lines">{it.allocation.map((a: any) => (
          <li key={a.id} className="line">
            <div className="line-top">
              <div>
                <strong className="line-name">{a.name}</strong>
                <span className="muted small">Product {a.id}</span>
              </div>
              <div className="line-nums num">
                <span>{num(a.sales_units)} × {a.sales_unit}</span>
                <span className="muted">{eur(Math.round(a.cost_cents / a.sales_units))} each</span>
                <strong>{eur(a.cost_cents)}</strong>
              </div>
            </div>
            <div className="why">
              <span className="why-label">Why this product</span>
              <ul>{a.reason.split('; ').map((f: string) => <li key={f}>{fact(f)}</li>)}</ul>
            </div>
          </li>
        ))}</ul>
      )}
      {!!lineFlags.length && <FlagList codes={lineFlags} />}

      {it.sure_option && (
        <div className="sure">
          <div className="sure-head">
            <Icon name="truck" size={18} />
            <div>
              <strong>Sure-delivery option</strong>
              <span>Same need from stock Valio confirms: {it.sure_option.lines.map((l: any) => `${num(l.units)} × ${l.name}`).join(' + ')}.
                {it.sure_option.shortfall > 0 && ` Covers all but ${num(it.sure_option.shortfall)} ${unit}.`}</span>
            </div>
            <span className="sure-cost num">{eur(it.sure_option.cost_cents)}<small>{it.sure_option.extra_cents >= 0 ? '+' : '−'}{eur(Math.abs(it.sure_option.extra_cents))}</small></span>
          </div>
          {open && <button className="btn" disabled={busy} onClick={() => revise({ confirmed_only: true })}><Icon name="check" />Use the sure-delivery option</button>}
        </div>
      )}
      {mode === 'confirmed' && (
        <p className="note-line tone-ok"><Icon name="truck" size={15} /><span>Using the sure-delivery option: every line has stock confirmed by Valio.
          {open && <> <button className="linklike" disabled={busy} onClick={() => revise({})}>Back to the best option</button></>}</span></p>
      )}

      {open && (
        <details className="change">
          <summary><Icon name="edit" size={15} />Change this item</summary>
          <div className="change-body">
            <form className="qty" onSubmit={setQuantity}>
              <label htmlFor={`qty-${hid}`}>Quantity</label>
              <span className="affix"><input id={`qty-${hid}`} type="number" min={0} step="any" value={qty} onChange={(e) => setQty(+e.target.value)} /><span>{unit}</span></span>
              <button className="btn" disabled={busy || !(qty > 0) || qty === it.item.quantity}>Update quantity</button>
            </form>
            {mode !== 'best' && (
              <div className="choice">
                <span>{mode === 'choose' ? 'You picked the product for this item.' : 'Using the sure-delivery option.'}</span>
                <button className="btn" disabled={busy} onClick={() => revise({})}>Back to the best option</button>
              </div>
            )}
            <p className="muted small">To use another product, choose it in the comparison below. Every change runs all checks again.</p>
          </div>
        </details>
      )}

      {!!it.options.length && (
        <details className="compare">
          <summary>Compare {it.options.length} product{it.options.length === 1 ? '' : 's'} that can be delivered</summary>
          {!!otherFlags.length && <FlagList codes={otherFlags} />}
          <p className="muted small">Products with stock Valio confirms are used first. The score weighs price, stock, delivery reliability, CO₂ and Finnish origin{it.ai_check?.answered ? `. Products that are not “${it.item.need}” were set aside by an AI check (listed below)` : ''}.</p>
          <div className="scroll"><table className="data">
            <thead><tr><th>Product</th><th className="r">Per {it.item.unit === 'pcs' ? 'piece' : it.item.unit}</th><th className="r">Stock</th><th className="r">Score</th><th /></tr></thead>
            <tbody>{it.options.filter((o: any, i: number) => all || i < 6 || chosen.has(o.id)).map((o: any) => {
              const delta = Math.round((o.unit_price_cents / best - 1) * 100);
              return (
                <tr key={o.id} className={chosen.has(o.id) ? 'in-order' : undefined}>
                  <td><div className="cell-title">{o.name}</div><div className="cell-sub">{o.id}{o.late && ', arrives late'}</div></td>
                  <td className="r" style={{ minWidth: 120 }}>
                    <div className="num">{eur(Math.round(o.unit_price_cents))}</div>
                    <div className={`delta ${delta === 0 ? 'best' : ''}`}>{delta === 0 ? 'cheapest' : `+${delta} %`}</div>
                    <div className="bar" aria-hidden="true"><span style={{ width: `${(o.unit_price_cents / worst) * 100}%` }} /></div>
                  </td>
                  <td className="r">{o.available === null ? <span className="unconfirmed">not confirmed</span> : <span className="num">{num(o.available)} {o.offer.sales_unit}</span>}</td>
                  <td className="r">
                    <span className="score">
                      <span className="minibars" role="img" aria-label={CRITERIA.map(([k, l]) => `${l} ${o.criteria[k] == null ? 'no data' : o.criteria[k].toFixed(2)}`).join(', ')}>
                        {CRITERIA.map(([k, l]) => <i key={k} className={o.criteria[k] == null ? 'na' : undefined} title={`${l}: ${o.criteria[k] == null ? 'no data' : o.criteria[k].toFixed(2)}`} style={{ height: `${(o.criteria[k] ?? 0) * 100}%` }} />)}
                      </span>
                      <span className="num">{o.score.toFixed(2)}</span>
                    </span>
                  </td>
                  <td className="r">{chosen.has(o.id) ? <Badge tone="ok">In the order</Badge> : open && <button className="btn sm" disabled={busy} onClick={() => revise({ choose: o.id })}>Use this</button>}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
          <div className="legend" aria-hidden="true">Bars: {CRITERIA.map(([, l]) => l).join(', ')}</div>
          {it.options.length > 6 && <button className="btn sm quiet" aria-expanded={all} onClick={() => setAll(!all)}>{all ? 'Show the top 6' : `Show all ${it.options.length}`}</button>}
          {!!it.dropped.length && (
            <details className="sub">
              <summary>{it.dropped.length} matching products that cannot be delivered by this date</summary>
              <div className="scroll"><table className="data"><tbody>{it.dropped.map((d: any) => (
                <tr key={d.id}><td><div className="cell-title">{d.name}</div><div className="cell-sub">{d.id}</div></td><td>{plain(d.reasons.join('; '))}</td></tr>
              ))}</tbody></table></div>
            </details>
          )}
          {!!it.excluded_total && (
            <details className="sub">
              <summary>{it.excluded_total} set aside by your limits or the AI product check{it.excluded_total > it.excluded.length && ` (first ${it.excluded.length} shown)`}</summary>
              <div className="scroll"><table className="data"><tbody>{it.excluded.map((d: any) => (
                <tr key={d.id}><td><div className="cell-title">{d.name}</div><div className="cell-sub">{d.id}</div></td><td>{d.reasons.join('; ')}</td></tr>
              ))}</tbody></table></div>
            </details>
          )}
        </details>
      )}
    </section>
  );
}

function summarize(e: any): { title: string; text?: string; tone: Tone } {
  const d = e.data;
  switch (e.event) {
    case 'created': return { title: 'Proposal made', tone: 'info',
      text: d.items.map((it: any) => `${num(it.item.quantity)} ${unitLabel(it.item.unit)} ${it.item.need}: ${it.allocation.length} line(s), ${eur(it.allocation.reduce((s: number, a: any) => s + a.cost_cents, 0))}`).join('; ') };
    case 'policy_verdict': return d.requires_human
      ? { title: 'Checks: a person must decide', tone: 'warn', text: d.rules.filter((r: any) => !r.ok).map((r: any) => RULES[r.rule]?.label ?? r.rule).join(', ') }
      : { title: 'Checks: all passed', tone: 'ok', text: 'The policy lets this order through without a person.' };
    case 'revised': { const r = d.revision; return { title: 'Changed', tone: 'info',
      text: r.choose ? `Chose product ${r.choose}` : r.confirmed_only ? 'Confirmed stock only' : r.quantity ? `Quantity set to ${num(r.quantity)}` : 'Back to best overall' }; }
    case 'revalidation_failed': return { title: 'Offers changed before approval', tone: 'bad',
      text: d.diffs.map((x: any) => `${x.id} ${x.what.replace(/_/g, ' ')}: ${x.before} → ${x.after}`).join('; ') };
    case 'approved': return { title: 'Approved', tone: 'ok', text: `Prices and stock re-checked with Valio${d.note ? `. Note: “${d.note}”` : ''}` };
    case 'rejected': return { title: 'Rejected', tone: 'bad', text: d.note };
    case 'request_confirmed': return { title: 'Request confirmed', tone: 'ok', text: 'A person confirmed this is what they meant.' };
    case 'request_corrected': return { title: 'Request corrected', tone: 'info',
      text: Object.entries(d.correction).map(([k, v]) => k === 'items' ? (v as any[]).map((it) => `${num(it.quantity)} ${unitLabel(it.unit)} ${it.need}`).join(', ') : k === 'deliver_by' ? `delivery ${day(v as string)}` : k === 'portions' ? `${v} portions` : `${k.replace(/_/g, ' ')}: ${(v as string[] | string).toString() || 'none'}`).join('; ') + '. Planned again.' };
    case 'autonomy_revoked': return { title: 'Agent autonomy switched off', tone: 'bad', text: 'A person rejected an order the agent finished on its own. From now on you sign off every order again.' };
    case 'exported': return { title: 'Webshop file downloaded', tone: 'neutral', text: `${d.lines} line(s), fingerprint ${d.sha256.slice(0, 12)}…` };
    default: return { title: e.event, tone: 'neutral' };
  }
}

function Timeline({ events }: { events: any[] }) {
  return (
    <section className="panel record">
      <h2>Decision record</h2>
      <p className="muted small">Every step, who took it and when. Entries cannot be edited or deleted.</p>
      <ol className="timeline">{events.map((e) => {
        const s = summarize(e);
        return (
          <li key={e.seq} className={`tl tone-${s.tone}`}>
            <span className="tl-dot" aria-hidden="true" />
            <div className="tl-head"><strong>{s.title}</strong><span className="muted small">{clock(e.at)}, {who(e.actor)}</span></div>
            {s.text && <p>{s.text}</p>}
            <details><summary>Full entry</summary><pre>{JSON.stringify(e.data, null, 2)}</pre></details>
          </li>
        );
      })}</ol>
    </section>
  );
}

// Voice input: the browser's own speech recognition (Chrome, Edge, Safari). No library, no key; Chrome sends the audio
// to Google to transcribe (context.md §15.4). Firefox has none: the button is not shown. Needs localhost or HTTPS.
const SPEECH_LANGS = [['en-GB', 'EN'], ['fi-FI', 'FI'], ['sv-SE', 'SV']] as const;
const SPEECH_ERRORS: Record<string, string> = {
  'not-allowed': 'Microphone access is blocked. Allow it in the address bar, then try again.',
  'service-not-allowed': 'Microphone access is blocked. Allow it in the address bar, then try again.',
  'no-speech': 'Nothing was heard. Press Speak and try again.',
  'audio-capture': 'No microphone was found.',
  network: 'The browser could not reach its speech service. Check the connection, or use Chrome, Edge or Safari.',
  'language-not-supported': 'This language is not supported by the browser. Try EN.',
};
function VoiceInput({ onText, disabled }: { onText: (text: string) => void; disabled: boolean }) {
  const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
  // Brave exposes the API but has no speech service behind it: every start fails at once with a network error.
  const brave = !!(navigator as any).brave;
  const rec = useRef<any>(null);
  const [listening, setListening] = useState(false);
  const [err, setErr] = useState('');
  const [lang, setLang] = useState(() => { try { return localStorage.getItem('speech-lang') ?? 'en-GB'; } catch { return 'en-GB'; } });
  useEffect(() => () => rec.current?.abort(), []);
  if (!SR || brave) return (
    <p className="muted small voice-none"><Icon name="mic" size={14} />Voice input works in Chrome, Edge and Safari{brave ? '; Brave blocks the speech service it needs' : ''}. Type instead, or open this page there.</p>
  );
  const pick = (l: string) => { setLang(l); try { localStorage.setItem('speech-lang', l); } catch { /* private mode */ } };
  const toggle = () => {
    if (listening) { rec.current?.stop(); return; }
    const r = new SR();
    // continuous: keeps listening through short pauses ("1000 litres … of lactose-free milk"); Stop ends it.
    r.lang = lang; r.interimResults = true; r.continuous = true;
    r.onresult = (e: any) => onText(Array.from(e.results as ArrayLike<any>).map((x) => x[0].transcript).join(' ').trim());
    r.onerror = (e: any) => {
      console.warn('speech recognition error:', e.error, e.message);
      if (e.error !== 'aborted') setErr(`${SPEECH_ERRORS[e.error] ?? 'Speech recognition stopped. Try again, or type instead.'} (${e.error})`);
    };
    r.onend = () => setListening(false);
    rec.current = r;
    setErr(''); onText(''); setListening(true);
    try { r.start(); } catch { setListening(false); }
  };
  return (
    <div className="voice">
      <button type="button" className={`btn mic ${listening ? 'on' : ''}`} aria-pressed={listening} disabled={disabled} onClick={toggle}>
        <Icon name={listening ? 'stop' : 'mic'} />{listening ? 'Stop' : 'Speak'}
      </button>
      <div className="segmented sm" role="group" aria-label="Language you speak">
        {SPEECH_LANGS.map(([l, label]) => <button type="button" key={l} aria-pressed={lang === l} disabled={listening} onClick={() => pick(l)}>{label}</button>)}
      </div>
      <span className={`voice-status ${err && !listening ? 'err' : ''}`} aria-live="polite">{listening ? 'Listening… say the product, the amount and the date.' : err}</span>
    </div>
  );
}

// ---------- New order: ask → the agent plans → confirm on the proposal (step 2 sits next to the plan) ----------
function NewOrder({ token }: { token: string }) {
  const [text, setText] = useState('');
  const [question, setQuestion] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const plan = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(''); setQuestion('');
    try {
      const { request, clarification } = await api(token, 'POST', '/parse', { text });
      if (clarification) { setQuestion(clarification); setBusy(false); return; }
      const p = await api(token, 'POST', '/proposals', { site: 'Hotel Kaisla Helsinki', ...request });
      toast('Proposal ready. Check that the agent understood you.');
      location.hash = `#/p/${p.id}`;
    } catch (e) {
      const q = (e as ApiError).body?.question;
      if (q) setQuestion(q); else setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <>
    <Band back={['#', 'All orders']} title="New order"
      steps={earlySteps(busy ? 1 : 0, busy ? { 1: 'checking prices with Valio…' } : {})}
      meta={<span><Icon name="shield" size={15} />Say it in your own words. You check what the agent understood before anything is approved.</span>} />
    <div className="wrap page narrow">
      <form className="ask" onSubmit={plan}>
        <label htmlFor="text" className="ask-label">What do you need, how much, and by when?</label>
        <div className="ask-box">
          <textarea id="text" rows={3} value={text} onChange={(e) => setText(e.target.value)} required
            placeholder="What do we order today?"
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit(); }} />
          <div className="ask-bar">
            <VoiceInput onText={setText} disabled={busy} />
            <button className="btn lime" disabled={busy || !text.trim()} aria-busy={busy}>
              {busy ? <><Icon name="loader" className="spin" />Checking prices with Valio…</> : 'Plan the order'}
            </button>
          </div>
        </div>
        {question && <Callout tone="info" icon="info" title="One question first">{question}</Callout>}
        {err && <Callout tone="bad" title="The order could not be planned">{err}</Callout>}

        <div className="try">
          <span className="try-label">Or start from an example</span>
          <div className="try-cards">
            {EXAMPLES.map((x) => (
              <button type="button" key={x.title} className="try-card" aria-pressed={text === x.text} onClick={() => setText(x.text)}>
                <span className="try-icon"><Icon name={x.icon} size={22} /></span>
                <span><strong>{x.title}</strong><span>“{x.text}”</span></span>
              </button>
            ))}
          </div>
        </div>

        <ul className="ask-notes">
          <li><Icon name="globe" size={16} />English, Finnish or Swedish, typed or spoken.</li>
          <li><Icon name="shield" size={16} />Diets and allergies you mention (“lactose-free”, “no nuts”) are always applied.</li>
          <li><Icon name="check" size={16} />You see what the agent understood and can fix it before anything is approved.</li>
          <li><Icon name="book" size={16} />Cooking a dish? <a href="#/recipes">Order for a recipe</a> instead.</li>
        </ul>
      </form>
    </div>
    </>
  );
}

// ---------- Recipes ----------
const DIET_FI: Record<string, string> = { Laktoositon: 'Lactose-free', Gluteeniton: 'Gluten-free', Vegaaninen: 'Vegan' };
function Recipes({ token }: { token: string }) {
  const [list, setList] = useState<any[] | null>(null);
  const [err, setErr] = useState('');
  const [diet, setDiet] = useState('');
  useEffect(() => { api(token, 'GET', '/recipes').then(setList, (e) => setErr(e.message)); }, [token]);
  return (
    <div className="wrap page">
      <h1>Order for a recipe</h1>
      <p className="lead">Professional-kitchen recipes from Valio Aimo. Pick a dish and the number of portions; the agent plans every ingredient into one order for you to check.</p>
      {err ? <Callout tone="bad" title="Recipes could not be loaded">{err}</Callout> : !list ? <Loading />
        : !list.length ? <Callout tone="info" title="No recipes yet">Run <code>npm run recipes</code> once, online, to fetch them.</Callout> : <>
          <div className="checks-row filters" role="group" aria-label="Show recipes that are">
            {['', ...Object.keys(DIET_FI)].map((d) => (
              <button key={d} className="chip-btn" aria-pressed={diet === d} onClick={() => setDiet(d)}>{d ? DIET_FI[d] : 'All'} <span>{d ? list.filter((r) => r.diets.includes(d)).length : list.length}</span></button>
            ))}
          </div>
          <div className="recipe-grid">{list.filter((r) => !diet || r.diets.includes(diet)).map((r) => (
            <a key={r.id} className="recipe-card" href={`#/recipes/${r.id}`}>
              {r.image ? <img src={r.image} alt="" loading="lazy" /> : <div className="img" />}
              <div className="body">
                <span className="course">{r.course}</span>
                <strong>{r.name}</strong>
                <span className="muted small">Serves {r.yield}, {r.ingredients} ingredients</span>
                {r.diets.some((d: string) => DIET_FI[d]) && <span className="tags">{r.diets.filter((d: string) => DIET_FI[d]).map((d: string) => <span key={d}>{DIET_FI[d]}</span>)}</span>}
              </div>
            </a>
          ))}</div>
        </>}
    </div>
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
  if (!r) return <div className="wrap page">{err ? <Callout tone="bad" title="The recipe could not be loaded">{err}</Callout> : <Loading />}</div>;
  const buy = r.lines.filter((l: any) => l.need && l.kg > 0 && (!l.pantry || pantry.includes(l.need))).length;
  const plan = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(''); setQuestion('');
    try {
      const p = await api(token, 'POST', `/recipes/${id}/plan`, { portions, pantry, diets, deliver_by: date || undefined });
      toast('Proposal ready. Check it and decide.'); location.hash = `#/p/${p.id}`;
    } catch (e) { const q = (e as ApiError).body?.question; if (q) setQuestion(q); else setErr((e as Error).message); setBusy(false); }
  };
  const toggle = (xs: string[], x: string) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);
  return (
    <>
    <Band back={['#/recipes', 'All recipes']} title={r.name}
      steps={earlySteps(busy ? 1 : 0, busy ? { 0: `a recipe, ${num(portions)} portions`, 1: 'checking prices with Valio…' } : { 0: `a recipe, ${num(portions)} portions` })}
      meta={<>
        <span><Icon name="book" size={15} />{r.course}, serves {r.yield} in the original</span>
        <a href={r.url} target="_blank" rel="noreferrer">See the recipe on valioaimo.fi<Icon name="external" size={13} /></a>
      </>} />
    <div className="wrap page">
      <div className="recipe-layout">
        <div>
          <section className="panel">
            {r.image && <img className="recipe-hero" src={r.image} alt="" />}
            <h2>Ingredients for {num(portions)} portions</h2>
            <p className="muted small">Amounts are scaled from the recipe and rounded up to 10 g. The agent then finds a product for each and rounds up to whole packs.</p>
            <div className="scroll"><table className="data">
              <thead><tr><th>In the recipe (serves {r.yield})</th><th className="r">You buy</th><th>Status</th></tr></thead>
              <tbody>{r.lines.map((l: any, i: number) => {
                const scaled = Math.ceil(+(l.kg * portions / r.yield * 100).toFixed(6)) / 100;
                return (
                  <tr key={i}>
                    <td><div>{l.text}</div>{l.product && <div className="cell-sub"><Icon name="check" size={12} />The recipe names a Valio product; it is used first if it can be delivered.</div>}</td>
                    <td className="r num">{l.need && l.kg > 0 && (!l.pantry || pantry.includes(l.need)) ? `${num(scaled)} kg` : '–'}</td>
                    <td>{!l.need ? <span className="muted small">Nothing to buy</span>
                      : l.kg <= 0 ? <span className="muted small">To taste</span>
                      : l.pantry ? <label className="check-pill small"><input type="checkbox" checked={pantry.includes(l.need)} onChange={() => setPantry(toggle(pantry, l.need))} />Usually in stock. Buy it too</label>
                      : <Badge tone="ok">Buy</Badge>}</td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          </section>
        </div>
        <aside className="rail">
          <form className="decision" onSubmit={plan}>
            <div className="decision-top"><h2>Plan this order</h2></div>
            <div className="decision-checks">
              <div className="field"><label htmlFor="portions">Portions</label>
                <input id="portions" type="number" min={1} max={5000} step={1} required value={portions} onChange={(e) => setPortions(Math.max(1, Math.round(+e.target.value)))} />
                <span className="hint">{num(portions / r.yield)} × the recipe</span></div>
              <div className="field"><label htmlFor="rdate">Deliver by</label>
                <input id="rdate" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                <span className="hint">For Monday many products’ order deadlines have already passed.</span></div>
              <fieldset className="field">
                <legend>Every ingredient must be</legend>
                <div className="checks-row">{DIETS.slice(0, 3).map(([d, l]) => (
                  <label key={d} className="check-pill"><input type="checkbox" checked={diets.includes(d)} onChange={() => setDiets(toggle(diets, d))} />{l}</label>
                ))}</div>
              </fieldset>
            </div>
            <div className="decision-act">
              <button className="btn lime block" disabled={busy || !buy} aria-busy={busy}>
                {busy ? <><Icon name="loader" className="spin" />Checking {buy} ingredients with Valio…</> : `Plan the order (${buy} ingredients)`}
              </button>
              <p className="act-note">You get a proposal to check. Nothing is ordered.</p>
              {question && <Callout tone="info" icon="info" title="One question first">{question}</Callout>}
              {err && <Callout tone="bad" title="The order could not be planned">{err}</Callout>}
            </div>
          </form>
        </aside>
      </div>
    </div>
    </>
  );
}

// ---------- Policy ----------
function Policy({ token, suggest }: { token: string; suggest: boolean }) {
  const [saved, setSaved] = useState<any>(null);
  const [pol, setPol] = useState<any>(null);
  const [trust, setTrust] = useState<any>(null);
  const [err, setErr] = useState('');
  const [fromTrust, setFromTrust] = useState(false);
  const [agentsOn, setAgentsOn] = useState(true);
  useEffect(() => { api(token, 'GET', '/agents').then((a) => setAgentsOn(a.enabled), () => {}); }, [token]);
  // Kill switch: not part of the policy draft, it takes effect at once.
  const switchAgents = (enabled: boolean) => api(token, 'PUT', '/agents', { enabled }).then((a) => {
    setAgentsOn(a.enabled); toast(a.enabled ? 'Agents are switched on again.' : 'All agents are switched off. They cannot search, plan or export.');
  }, (e) => setErr(e.message));
  useEffect(() => {
    Promise.all([api(token, 'GET', '/policy'), api(token, 'GET', '/trust').catch(() => null)]).then(([p, t]) => {
      setSaved(p); setTrust(t); setPol(suggest && t?.suggestion ? t.suggestion.policy : p); setFromTrust(suggest && !!t?.suggestion);
    }, (e) => setErr(e.message));
  }, [token, suggest]);
  if (!pol) return <div className="wrap page">{err ? <Callout tone="bad" title="The policy could not be loaded">{err}</Callout> : <Loading />}</div>;
  const dirty = JSON.stringify(pol) !== JSON.stringify(saved);
  const set = (k: string, v: unknown) => setPol({ ...pol, [k]: v });
  const save = () => api(token, 'PUT', '/policy', pol).then((p) => { setSaved(p); setPol(p); setFromTrust(false); toast('Policy saved. It applies to new proposals and changes.'); }, (e) => setErr(e.message));
  // Plain render helpers, not components: keeps input focus while typing.
  const toggle = (k: string, title: string, on: string, off: string) => (
    <label className="setting">
      <div><strong>{title}</strong><p>{pol[k] ? on : off}</p></div>
      <input type="checkbox" role="switch" className="switch" checked={pol[k]} onChange={(e) => set(k, e.target.checked)} aria-label={title} />
    </label>
  );
  const amount = (k: string, title: string, now: string, suffix: string) => (
    <div className="setting">
      <div><label htmlFor={k}><strong>{title}</strong></label><p>{now}</p></div>
      <span className="affix"><input id={k} type="number" min={0} value={pol[k]} onChange={(e) => set(k, +e.target.value)} /><span>{suffix}</span></span>
    </div>
  );
  return (
    <div className="wrap page narrow">
      <h1>Policy</h1>
      <p className="lead">The rules every proposal is checked against. When all checks pass and you allow it, the agent may finish an order without you. Otherwise it waits for you.</p>
      {fromTrust && <Callout tone="ok" icon="spark" title="Suggested from your approval history">The values below are a suggestion. Nothing changes until you save.</Callout>}
      <p className="setting-note"><Icon name="lock" size={14} />Only you can change it here. The AI agent can read the policy but never change it.</p>
      {err && <Callout tone="bad">{err}</Callout>}

      <section className="panel">
        <h2>Who signs off</h2>
        {toggle('agent_may_finalise', 'The agent may finish orders on its own',
          'Now: when every check below passes, the agent may send the order to the webshop without you.',
          'Now: you sign off every order, whatever it costs. This is the safe start.')}
        <label className="setting">
          <div><strong>Agents may work for you</strong><p>{agentsOn
            ? 'Now: AI agents can search, plan and propose orders. Switch off to stop every agent at once.'
            : 'Now: every agent is switched off. Nothing reaches the gateway until you switch them on again.'}</p></div>
          <input type="checkbox" role="switch" className="switch" checked={agentsOn} onChange={(e) => switchAgents(e.target.checked)} aria-label="Agents may work for you" />
        </label>
      </section>
      <section className="panel">
        <h2>Money</h2>
        {amount('max_order_eur', 'Order limit', `Now: orders above €${pol.max_order_eur} wait for you.`, '€')}
        {amount('max_line_eur', 'Line limit', `Now: any single line above €${pol.max_line_eur} waits for you.`, '€')}
        {amount('max_over_best_price_pct', 'Price vs. the cheapest', `Now: a product more than ${pol.max_over_best_price_pct} % dearer per litre or kilo than the cheapest one sure to be delivered waits for you.`, '%')}
      </section>
      <section className="panel">
        <h2>Stock</h2>
        {toggle('allow_unconfirmed_stock', 'Accept products without a confirmed stock amount',
          'Now: when Valio reports no amount for a product (it can still be ordered), the agent may use it, also when it finishes an order on its own.',
          'Now: a line without a confirmed amount waits for you, with a sure-delivery option next to it. Finishing alone, the agent takes the sure option.')}
        {toggle('allow_split', 'Allow splitting an item',
          'Now: when one product is short, the agent may split the item across up to three products.',
          'Now: a split item waits for you.')}
      </section>
      <section className="panel">
        <h2><Icon name="lock" />Always checked by a person</h2>
        <p className="muted">Fixed rules. No setting, and no agent, can turn them off.</p>
        <ul className="hard">
          {['allergen_and_diet_limits', 'alcohol_needs_human', 'need_covered', 'on_time', 'live_prices', 'matches_request_text', 'usual_quantity', 'request_budget'].map((k) => (
            <li key={k}><strong>{RULES[k].label}</strong><span>{RULES[k].why}</span></li>
          ))}
        </ul>
      </section>
      <section className="panel">
        <h2><Icon name="spark" />How trust grows</h2>
        <ul className="trust-rules">
          <li><strong>Earned by approvals.</strong> Each proposal you approve without changing it counts. After {trust?.threshold ?? 3} in a row, we suggest letting the agent finish orders up to a little more than the largest of them.</li>
          <li><strong>Learned from what you accepted.</strong> If you accepted the same thing every time, such as an item split across products, the suggestion allows it too. The fixed rules above are never loosened.</li>
          <li><strong>Only for routine orders.</strong> The agent finishes an order alone only for products you have approved at least 3 times. Anything new waits for you.</li>
          <li><strong>Lost at once.</strong> A change or a rejection starts the count again. Rejecting an order the agent finished alone switches its autonomy off straight away.</li>
        </ul>
        {trust && <p className="trust-count"><strong className="num">{Math.min(trust.streak, trust.threshold)}</strong> of {trust.threshold} unchanged approvals in a row{trust.streak > trust.threshold && ` (${trust.streak} so far)`}</p>}
        <p className="muted small">Agent keys can only be stricter than this policy, never looser.</p>
      </section>
      <div className="savebar">
        <span>{dirty ? 'You have unsaved changes' : 'Everything is saved'}</span>
        <button className="btn quiet" disabled={!dirty} onClick={() => { setPol(saved); setFromTrust(false); }}>Discard</button>
        <button className="btn lime" disabled={!dirty} onClick={save}>Save policy</button>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
