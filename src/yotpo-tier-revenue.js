// Net Sales by Yotpo tier — cached, month by month (added 2026-10-08).
//
// Why: computing a tier's Net Sales means paging through EVERY Shopify order
// in the range (fetchOrdersForTierRevenue) and matching each customer email
// to a Yotpo tier. A full month now takes 45–50 s for ND.COM, which is past
// the 25 s budget /api/yotpo/summary has, so Net Sales showed "—" on every
// closed month (and was never computed at all for quarters / YTD).
//
// How:
// - A range is split into calendar-month slices (the last one may be a
//   partial, in-progress month). Each slice is computed once and stored in
//   Postgres (yotpo_tier_revenue_cache) plus memory.
// - Quarters / YTD = the sum of their month slices.
// - Computing runs in the background, one slice at a time per store (so it
//   never floods that store's Shopify rate limit). The API waits up to a few
//   seconds; if the numbers aren't ready it says so and the dashboard
//   re-asks a little later.
// - Freshness: an in-progress month is recomputed after 30 min; a closed
//   month is final once computed after it ended, and refreshed weekly (tier
//   membership drifts slowly). A stale copy is always served while the
//   refresh runs.
// - Closed months of the current year are pre-computed for every store
//   shortly after the server starts.

const { fetchOrdersForTierRevenue } = require('./shopify');
const { getYotpoCustomerTierMap, getPool } = require('./yotpo');

const OPEN_FRESH_MS = 30 * 60 * 1000;
const CLOSED_FRESH_MS = 7 * 24 * 3600 * 1000;
const DAY_MS = 86400000;

const mem = new Map();       // key -> { by_tier, orders, matched, computed_at }
const inFlight = new Map();  // key -> Promise
const queues = new Map();    // site -> Promise chain (one slice at a time per store)

const keyOf = (site, s, e) => `${site}|${s}|${e}`;
const ymd = (d) => d.toISOString().slice(0, 10);

function monthSlices(start, end) {
  const out = [];
  let s = new Date(`${start}T00:00:00Z`);
  const e = new Date(`${end}T00:00:00Z`);
  while (s < e) {
    const next = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 1));
    const sliceEnd = next < e ? next : e;
    out.push({ start: ymd(s), end: ymd(sliceEnd) });
    s = sliceEnd;
  }
  return out;
}

// A slice is "closed" once its whole range is in the past (with a day's
// margin for the store's timezone and late order edits).
function isClosed(slice) {
  return new Date(`${slice.end}T00:00:00Z`).getTime() + DAY_MS <= Date.now();
}

function isFresh(slice, entry) {
  if (!entry) return false;
  const at = new Date(entry.computed_at).getTime();
  if (isClosed(slice)) {
    const endedAt = new Date(`${slice.end}T00:00:00Z`).getTime() + DAY_MS;
    return at >= endedAt && Date.now() - at < CLOSED_FRESH_MS;
  }
  return Date.now() - at < OPEN_FRESH_MS;
}

let schemaReady = null;
function ensureSchema() {
  const p = getPool();
  if (!p) return Promise.resolve(false);
  if (!schemaReady) {
    schemaReady = p.query(`
      CREATE TABLE IF NOT EXISTS yotpo_tier_revenue_cache (
        site TEXT NOT NULL,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        by_tier JSONB NOT NULL,
        orders INTEGER,
        matched INTEGER,
        computed_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (site, start_date, end_date)
      )`).then(() => true).catch((err) => { schemaReady = null; console.error('yotpo-tier-revenue: schema failed:', err.message); return false; });
  }
  return schemaReady;
}

async function readCache(site, slice) {
  const k = keyOf(site, slice.start, slice.end);
  if (mem.has(k)) return mem.get(k);
  if (!(await ensureSchema())) return null;
  try {
    const { rows } = await getPool().query(
      'SELECT by_tier, orders, matched, computed_at FROM yotpo_tier_revenue_cache WHERE site = $1 AND start_date = $2 AND end_date = $3',
      [site, slice.start, slice.end]
    );
    if (!rows.length) return null;
    const entry = { by_tier: rows[0].by_tier, orders: rows[0].orders, matched: rows[0].matched, computed_at: new Date(rows[0].computed_at).toISOString() };
    mem.set(k, entry);
    return entry;
  } catch (err) {
    console.error('yotpo-tier-revenue: cache read failed:', err.message);
    return null;
  }
}

async function writeCache(site, slice, entry) {
  mem.set(keyOf(site, slice.start, slice.end), entry);
  if (!(await ensureSchema())) return;
  try {
    await getPool().query(
      `INSERT INTO yotpo_tier_revenue_cache (site, start_date, end_date, by_tier, orders, matched, computed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (site, start_date, end_date) DO UPDATE
       SET by_tier = EXCLUDED.by_tier, orders = EXCLUDED.orders, matched = EXCLUDED.matched, computed_at = EXCLUDED.computed_at`,
      [site, slice.start, slice.end, JSON.stringify(entry.by_tier), entry.orders, entry.matched, entry.computed_at]
    );
  } catch (err) {
    console.error('yotpo-tier-revenue: cache write failed:', err.message);
  }
}

// Same definition as before (moved from server.js): Net Sales per order =
// sum(lineItems.originalTotalSet) − totalDiscountsSet, counted only for
// customers whose email matches a known Yotpo member of this store.
async function computeSlice(site, slice) {
  const [orders, tierByEmail] = await Promise.all([
    fetchOrdersForTierRevenue(site, slice.start, slice.end),
    getYotpoCustomerTierMap(site),
  ]);
  const byTier = {};
  let matched = 0;
  for (const order of orders) {
    const email = order.customer && order.customer.email ? order.customer.email.toLowerCase() : null;
    if (!email) continue;
    const tier = tierByEmail.get(email);
    if (!tier) continue;
    const gross = order.lineItems.edges.reduce(
      (sum, e) => sum + Number((e.node.originalTotalSet && e.node.originalTotalSet.shopMoney && e.node.originalTotalSet.shopMoney.amount) || 0),
      0
    );
    const discount = Number((order.totalDiscountsSet && order.totalDiscountsSet.shopMoney && order.totalDiscountsSet.shopMoney.amount) || 0);
    byTier[tier] = (byTier[tier] || 0) + (gross - discount);
    matched++;
  }
  return { by_tier: byTier, orders: orders.length, matched, computed_at: new Date().toISOString() };
}

// Queues a slice for (re)computation; one slice at a time per store.
function refresh(site, slice) {
  const k = keyOf(site, slice.start, slice.end);
  if (inFlight.has(k)) return inFlight.get(k);
  const prev = queues.get(site) || Promise.resolve();
  const job = prev.catch(() => {}).then(async () => {
    const t0 = Date.now();
    try {
      const entry = await computeSlice(site, slice);
      await writeCache(site, slice, entry);
      console.log(`yotpo-tier-revenue: ${site} ${slice.start}..${slice.end} computed in ${Math.round((Date.now() - t0) / 1000)}s (${entry.orders} orders, ${entry.matched} matched)`);
      return entry;
    } finally {
      inFlight.delete(k);
    }
  });
  inFlight.set(k, job);
  queues.set(site, job.catch(() => {}));
  return job;
}

// Returns { by_tier, complete, ready, total, pending, computed_at, error }.
// Waits up to `waitMs` for anything missing; whatever isn't ready by then
// keeps computing in the background.
async function getTierRevenue(site, start, end, { waitMs = 15000 } = {}) {
  const slices = monthSlices(start, end);
  const entries = await Promise.all(slices.map((s) => readCache(site, s)));
  const missing = [];
  let lastError = null;
  slices.forEach((s, i) => {
    if (isFresh(s, entries[i])) return;
    const job = refresh(site, s);
    job.catch((err) => { lastError = err; console.error(`yotpo-tier-revenue: ${site} ${s.start}..${s.end} failed:`, err.message); });
    if (!entries[i]) missing.push({ i, job });
  });
  if (missing.length) {
    let timer;
    await Promise.race([
      Promise.all(missing.map((m) => m.job.then((v) => { entries[m.i] = v; }).catch((err) => { lastError = err; }))),
      new Promise((r) => { timer = setTimeout(r, waitMs); }),
    ]);
    clearTimeout(timer);
  }
  const ready = entries.filter(Boolean).length;
  const byTier = {};
  let oldest = null;
  for (const e of entries) {
    if (!e) continue;
    for (const [t, v] of Object.entries(e.by_tier || {})) byTier[t] = (byTier[t] || 0) + Number(v || 0);
    if (!oldest || e.computed_at < oldest) oldest = e.computed_at;
  }
  return {
    by_tier: byTier,
    complete: ready === slices.length,
    ready,
    total: slices.length,
    computed_at: oldest,
    error: ready === slices.length ? null : (lastError ? lastError.message : null),
  };
}

// Pre-computes the closed months of the current year for each store, so
// quarters / YTD / past months are ready before anyone opens them.
function prewarm(sites) {
  const now = new Date();
  const yearStart = `${now.getUTCFullYear()}-01-01`;
  const thisMonth = ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  if (yearStart >= thisMonth) return;
  const slices = monthSlices(yearStart, thisMonth);
  for (const site of sites) {
    (async () => {
      for (const s of slices) {
        const entry = await readCache(site, s);
        if (!isFresh(s, entry)) refresh(site, s).catch((err) => console.error(`yotpo-tier-revenue: prewarm ${site} ${s.start} failed:`, err.message));
      }
    })().catch((err) => console.error('yotpo-tier-revenue: prewarm failed:', err.message));
  }
}

module.exports = { getTierRevenue, prewarm, monthSlices };
