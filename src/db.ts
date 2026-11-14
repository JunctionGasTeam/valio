// Catalogue database: schema + loader from the dataset files (context.md §10).
// Build: `npm run db` → data/valio.db (gitignored with data/).
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export const DB_PATH = process.env.DB_PATH ?? 'data/valio.db';
const DATA = 'data/valio_aimo_junction26_';

export function openDb(path = DB_PATH) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  // Runtime tables survive catalogue rebuilds (the offer cache is the demo backup, §11.3).
  db.exec(`
    CREATE TABLE IF NOT EXISTS offer_cache (
      endpoint TEXT, product TEXT, date TEXT, response TEXT, fetched_at TEXT, PRIMARY KEY (endpoint, product, date));
    CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY, name TEXT, policy TEXT, agents_enabled INTEGER DEFAULT 1);
    CREATE TABLE IF NOT EXISTS tokens (
      token TEXT PRIMARY KEY, customer TEXT REFERENCES customers(id), name TEXT,
      role TEXT CHECK (role IN ('requester', 'approver', 'agent')), limits TEXT, revoked INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY, customer TEXT REFERENCES customers(id), status TEXT, request TEXT, items TEXT, verdict TEXT,
      created_by TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS audit (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, proposal TEXT, customer TEXT, at TEXT, actor TEXT, event TEXT, data TEXT);
    CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
  `);
  return db;
}

const SCHEMA = `
DROP TABLE IF EXISTS products; DROP TABLE IF EXISTS products_fts; DROP TABLE IF EXISTS substitutions;
CREATE TABLE products (
  id TEXT PRIMARY KEY, gtin TEXT, name_fi TEXT, name_en TEXT, name_sv TEXT, brand TEXT,
  vendor TEXT, category TEXT, origin TEXT, sales_unit TEXT, base_unit TEXT, lot_size REAL,
  content_l REAL, content_kg REAL,        -- per sales unit; NULL = unknown (estimate from price, §7.2)
  temperature INTEGER, vat_code TEXT,
  contains TEXT, may_contain TEXT, free_from TEXT,  -- JSON arrays of GS1 allergen codes
  has_allergen_statement INTEGER,         -- 0 → E8 whenever an allergen/diet limit applies
  claims TEXT, labels TEXT,               -- JSON arrays
  co2_per_kg REAL, reliability REAL
);
CREATE VIRTUAL TABLE products_fts USING fts5(
  id UNINDEXED, name_fi, name_en, name_sv, brand, tokenize = 'trigram remove_diacritics 1'
);
CREATE TABLE substitutions (product TEXT, substitute TEXT, PRIMARY KEY (product, substitute));
CREATE INDEX products_category ON products(category);
`;

type Measure = { unit?: string; value?: number } | undefined;
type Conversion = { synkkaPackagingType: string; volume?: Measure; netWeight?: Measure };
type Classification = { name: string; values: { id: string; unit?: string }[] };
export type RawProduct = {
  id: string; salesUnit: string; baseUnit: string; category: string; allowedLotSize: number;
  temperatureCondition?: number; vendorName?: string; countryOfOrigin?: string; salesUnitGtin?: string;
  units: { unitId: string; sizeInBaseUnits: number }[];
  substitutions?: { product: string; substituteProduct: string }[];
  synkkaData: {
    gtin?: string; brand?: string; vatCode?: string;
    names?: { value: string; language: string }[];
    unitConversions?: Conversion[] | null;
    classifications?: Classification[];
  };
};

const LITRES: Record<string, number> = { LTR: 1, CLT: 0.01, MLT: 0.001 };
const KILOS: Record<string, number> = { KGM: 1, GRM: 0.001 };

function amount(m: Measure, table: Record<string, number>) {
  const f = m?.unit && table[m.unit];
  return f && m.value ? m.value * f : null;
}

/** Litres and kilograms in one sales unit, from units[] × packaging data. */
export function contentPerSalesUnit(p: RawProduct): { l: number | null; kg: number | null } {
  if (p.salesUnit === 'KG') return { l: null, kg: 1 };
  const size = (u: string) => p.units.find((x) => x.unitId === u)?.sizeInBaseUnits;
  const salesSize = size(p.salesUnit) ?? 1;
  const conv = p.synkkaData.unitConversions ?? [];
  const base = conv.find((c) => c.synkkaPackagingType === 'BASE_UNIT_OR_EACH');
  const kase = conv.find((c) => c.synkkaPackagingType === 'CASE');
  // BASE_UNIT_OR_EACH describes one base unit. CASE describes the case (KI when present, else the sales unit).
  const [c, factor] = base ? [base, salesSize] : kase ? [kase, salesSize / (size('KI') ?? salesSize)] : [null, 0];
  if (!c) return { l: null, kg: null };
  const l = amount(c.volume, LITRES);
  // `volume` is sometimes filled with a weight unit; take it as weight when netWeight is missing.
  const kg = amount(c.netWeight, KILOS) ?? amount(c.volume, KILOS);
  return { l: l && round(l * factor), kg: kg && round(kg * factor) };
}

const round = (x: number) => Math.round(x * 1e6) / 1e6;

function classValues(p: RawProduct, name: string) {
  return p.synkkaData.classifications?.find((c) => c.name === name)?.values ?? [];
}

function readCsv(file: string) {
  const out = new Map<string, number>();
  for (const line of readFileSync(file, 'utf8').split('\n').slice(1)) {
    const [id, v] = line.split(',');
    if (id && v) out.set(id.trim(), Number(v));
  }
  return out;
}

export function build(path = DB_PATH) {
  const db = openDb(path);
  db.exec(SCHEMA);
  const products: RawProduct[] = JSON.parse(readFileSync(DATA + 'product_data.json', 'utf8'));
  const co2 = readCsv(DATA + 'carbon_footprint.csv');
  const rel = readCsv(DATA + 'delivery_reliability.csv');

  const ins = db.prepare(`INSERT INTO products VALUES (${Array(24).fill('?').join(',')})`);
  const fts = db.prepare('INSERT INTO products_fts VALUES (?,?,?,?,?)');
  const sub = db.prepare('INSERT OR IGNORE INTO substitutions VALUES (?,?)');
  const json = (xs: string[]) => JSON.stringify(xs);

  db.exec('BEGIN');
  for (const p of products) {
    const s = p.synkkaData;
    const name = (lang: string) => s.names?.find((n) => n.language === lang)?.value ?? null;
    const allergens = classValues(p, 'allergen');
    const non = classValues(p, 'nonAllergen');
    const { l, kg } = contentPerSalesUnit(p);
    const ids = (vs: { id: string; unit?: string }[], unit: string) => vs.filter((v) => v.unit === unit).map((v) => v.id);
    ins.run(
      p.id, p.salesUnitGtin ?? s.gtin ?? null, name('fi'), name('en'), name('sv'), s.brand ?? null,
      p.vendorName ?? null, p.category, p.countryOfOrigin ?? null, p.salesUnit, p.baseUnit, p.allowedLotSize,
      l, kg, p.temperatureCondition ?? null, s.vatCode ?? null,
      json(ids(allergens, 'CONTAINS')), json(ids(allergens, 'MAY_CONTAIN')), json(ids(non, 'FREE_FROM')),
      allergens.length + non.length > 0 ? 1 : 0,
      json(classValues(p, 'nutritionalClaim').map((v) => v.id)), json(classValues(p, 'packagingMarkedLabel').map((v) => v.id)),
      co2.get(p.id) ?? null, rel.get(p.id) ?? null,
    );
    fts.run(p.id, name('fi'), name('en'), name('sv'), s.brand ?? null);
    for (const x of p.substitutions ?? []) sub.run(x.product, x.substituteProduct);
  }
  db.exec('COMMIT');
  return db;
}

if (import.meta.main) {
  const t = Date.now();
  const db = build();
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  console.log({
    products: n('SELECT count(*) n FROM products'),
    with_litres: n('SELECT count(*) n FROM products WHERE content_l IS NOT NULL'),
    with_kg: n('SELECT count(*) n FROM products WHERE content_kg IS NOT NULL'),
    no_content: n('SELECT count(*) n FROM products WHERE content_l IS NULL AND content_kg IS NULL'),
    allergen_statement: n('SELECT count(*) n FROM products WHERE has_allergen_statement'),
    co2: n('SELECT count(*) n FROM products WHERE co2_per_kg IS NOT NULL'),
    reliability: n('SELECT count(*) n FROM products WHERE reliability IS NOT NULL'),
    substitutions: n('SELECT count(*) n FROM substitutions'),
    ms: Date.now() - t,
  });
}
