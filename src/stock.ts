// Mock of the kitchen's own stock system (context.md §4c). Kitchens keep stock in their own software; the agent reads
// it, sees what runs out before the next delivery and proposes the refill. Every proposal still goes through the same
// planner, policy and approval as one typed by a person.
// ponytail: fixed readings for the demo customer, nothing moves when orders arrive. A real connector reads the
// customer's system (API or export, §15) and returns the same Reading shape; nothing else changes.
type Unit = 'l' | 'kg' | 'pcs';
export type Reading = {
  name: string; need: string; unit: Unit; diets: ('lactose_free' | 'gluten_free' | 'vegan' | 'vegetarian')[];
  on_hand: number; daily_use: number; par: number; // par: the level the kitchen refills to
};

export const SYSTEM = 'Kitchen stock system (demo)';
const STOCK: Record<string, { site: string; items: Reading[] }> = {
  kaisla: {
    site: 'Hotel Kaisla Helsinki',
    items: [
      { name: 'Lactose-free milk', need: 'maito', unit: 'l', diets: ['lactose_free'], on_hand: 80, daily_use: 40, par: 280 },
      { name: 'Butter', need: 'voi', unit: 'kg', diets: [], on_hand: 3, daily_use: 1.5, par: 13 },
      { name: 'Grated cheese', need: 'juustoraaste', unit: 'kg', diets: [], on_hand: 14, daily_use: 2, par: 20 },
      { name: 'Cream', need: 'kerma', unit: 'l', diets: [], on_hand: 24, daily_use: 4, par: 30 },
      { name: 'Rice', need: 'riisi', unit: 'kg', diets: [], on_hand: 22, daily_use: 2.5, par: 35 },
      { name: 'Eggs', need: 'kananmuna', unit: 'kg', diets: [], on_hand: 12, daily_use: 3, par: 25 },
    ],
  },
};
// Every kitchen registered in the app is a copy of the demo kitchen, so it reads the same stock system.
export const stockOf = (customer: string) => STOCK[customer] ?? STOCK.kaisla;

// Running low: lasts less than this many days. The refill is wanted before it runs out, never later than that.
export const LOW_DAYS = 3;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

/** What the agent makes of one reading. `incoming`: amounts already in open orders it made from the stock system. */
export function assess(r: Reading, incoming: number, today: string) {
  const have = r.on_hand + incoming;
  const days_left = Math.round((have / r.daily_use) * 10) / 10;
  const low = days_left < LOW_DAYS;
  return {
    ...r, incoming, days_left, low,
    order: low ? Math.ceil(r.par - have) : 0, // refill to par, whole litres / kilos / pieces
    deliver_by: addDays(today, Math.max(1, Math.floor(days_left))), // the last full day it still lasts
  };
}
