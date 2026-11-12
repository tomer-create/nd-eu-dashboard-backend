// Closed-month cache — added 2026-10-04.
//
// Why this exists: the dashboard embeds a static snapshot of every past month
// in public/index.html, but nothing ever finalized a month once it closed.
// On the 1st of each month the month that just ended was left as an empty
// placeholder (all zeros), so it showed "no results" and silently dropped out
// of every Year-to-Date total until someone hand-baked it into the HTML. A
// full past month on ND.COM also takes ~90–110s to pull live from Shopify
// (current period + YoY + MoM), which is slow to repeat on every page load.
//
// What it does: when /api/data is asked for an exact, fully-closed calendar
// month (start = the 1st, end = the 1st of the next month, end <= today), the
// result is stored in Postgres (same DATABASE_URL the Yotpo section already
// uses) and served from there on later requests — instant instead of ~100s.
//
// Freshness: numbers for a just-closed month can still move a little for a
// while (late refunds, and the P&L Google Sheet's cost/channel rows usually
// get filled in a few days after month end). So for months that closed in
// the last REFRESH_WINDOW_DAYS, a cached copy older than STALE_AFTER_HOURS is
// still returned immediately, and a fresh pull is kicked off in the
// background to replace it (stale-while-revalidate). Older months are stable
// and are served from cache as-is. Passing refresh=1 (the dashboard's Sync
// button does this) always does a fresh pull and updates the cache.
//
// If DATABASE_URL isn't configured, or the database errors, everything falls
// back to a normal live pull — the cache can only make things faster, never
// break a request.

const { getPool } = require('./yotpo');

const STALE_AFTER_HOURS = 6;
const REFRESH_WINDOW_DAYS = 45;

let schemaReady = null;
function ensureMonthCacheSchema() {
  const p = getPool();
  if (!p) return Promise.resolve(false);
  if (!schemaReady) {
    schemaReady = p
      .query(`
        CREATE TABLE IF NOT EXISTS month_snapshots (
          site TEXT NOT NULL,
          start_date DATE NOT NULL,
          end_date DATE NOT NULL,
          compare TEXT NOT NULL,
          payload JSONB NOT NULL,
          fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (site, start_date, end_date, compare)
        );
      `)
      .then(() => true)
      .catch((err) => {
        console.error('month-cache: schema migration failed:', err.message);
        schemaReady = null;
        return false;
      });
  }
  return schemaReady;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// True only for an exact calendar month that has fully ended.
function isClosedFullMonth(start, end) {
  if (!/^\d{4}-\d{2}-01$/.test(String(start)) || !/^\d{4}-\d{2}-01$/.test(String(end))) return false;
  const s = new Date(start + 'T00:00:00Z');
  const expectedEnd = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  // Strictly before today (UTC): on the 1st itself ND.COM's month is still
  // running for up to 5 hours after UTC midnight (2026-10-29 code review).
  return end === expectedEnd && end < todayISO();
}

function daysSince(isoDate) {
  return (Date.now() - new Date(isoDate + 'T00:00:00Z').getTime()) / 86400000;
}

async function readCache(site, start, end, compareKey) {
  const p = getPool();
  if (!p || !(await ensureMonthCacheSchema())) return null;
  const { rows } = await p.query(
    'SELECT payload, fetched_at FROM month_snapshots WHERE site = $1 AND start_date = $2 AND end_date = $3 AND compare = $4',
    [site, start, end, compareKey]
  );
  return rows[0] || null;
}

async function writeCache(site, start, end, compareKey, payload) {
  const p = getPool();
  if (!p || !(await ensureMonthCacheSchema())) return;
  await p.query(
    `INSERT INTO month_snapshots (site, start_date, end_date, compare, payload, fetched_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (site, start_date, end_date, compare)
     DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()`,
    [site, start, end, compareKey, JSON.stringify(payload)]
  );
}

// One live pull at a time per key — several people opening the dashboard on
// the 1st of the month shouldn't each start their own ~100s Shopify pull.
const inFlight = new Map();
// Closed months stored before a payload change (see `outdated` below) are
// re-pulled one at a time in the background.
let upgradeChain = Promise.resolve();
const upgradeQueued = new Set();
function pullAndStore(key, args, build) {
  if (inFlight.has(key)) return inFlight.get(key);
  const { site, start, end, compareKey } = args;
  const promise = build()
    .then(async (payload) => {
      try {
        await writeCache(site, start, end, compareKey, payload);
      } catch (err) {
        console.error('month-cache: write failed:', err.message);
      }
      return payload;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

// Wraps a live pull (`build`, a function returning a promise of the
// /api/data payload) with the closed-month cache. Returns
// { payload, cache: 'hit' | 'stale' | 'miss' | 'refresh' | 'bypass' }.
// ---- The month in progress (2026-11-12, reliability pass) ----
// Every page open used to start its own full pull of the current month for
// all three stores (~30–60 s each, with YoY and MoM), so a few people opening
// the dashboard together overloaded Shopify / Triple Whale and timed out.
// Now a pull is shared for a short while, in memory:
// - under OPEN_FRESH_MS old: served as is;
// - under OPEN_MAX_STALE_MS old: served at once, and a new pull starts in the
//   background for the next viewer;
// - older (or none): a new pull, shared by everyone asking at that moment.
// Sync (refresh=1) always gets a new pull, unless one started in the last
// OPEN_JUST_PULLED_MS (someone else just pressed Sync) or is running now.
// A pull that came back with a source missing (partial_sources) is only
// kept for OPEN_JUST_PULLED_MS. `fetchedAt` tells the page how old it is.
const OPEN_FRESH_MS = 5 * 60 * 1000;
const OPEN_MAX_STALE_MS = 30 * 60 * 1000;
const OPEN_JUST_PULLED_MS = 60 * 1000;
const openCache = new Map(); // key -> { payload, at, partial }
const openInFlight = new Map(); // key -> { promise, startedAt }
function openPull(key, build) {
  const running = openInFlight.get(key);
  if (running) return running.promise;
  const startedAt = Date.now();
  const promise = build()
    .then((payload) => {
      const partial = !!(payload && Array.isArray(payload.partial_sources) && payload.partial_sources.length);
      openCache.set(key, { payload, at: startedAt, partial });
      if (openCache.size > 60) openCache.delete(openCache.keys().next().value);
      return { payload, at: startedAt };
    })
    .finally(() => openInFlight.delete(key));
  openInFlight.set(key, { promise, startedAt });
  return promise;
}
async function getOpenPeriod({ site, start, end, compare, refresh }, build) {
  const key = [site, start, end, [...compare].sort().join(',')].join('|');
  const hit = openCache.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;
  const running = openInFlight.get(key);
  if (refresh) {
    if (running) {
      const r = await running.promise;
      return { payload: r.payload, cache: 'open-shared', fetchedAt: r.at };
    }
    if (hit && age < OPEN_JUST_PULLED_MS) return { payload: hit.payload, cache: 'open-hit', fetchedAt: hit.at };
    const r = await openPull(key, build);
    return { payload: r.payload, cache: 'open-refresh', fetchedAt: r.at };
  }
  const maxFresh = hit && hit.partial ? OPEN_JUST_PULLED_MS : OPEN_FRESH_MS;
  if (hit && age < maxFresh) return { payload: hit.payload, cache: 'open-hit', fetchedAt: hit.at };
  if (hit && !hit.partial && age < OPEN_MAX_STALE_MS) {
    openPull(key, build).catch((err) => console.error('month-cache: background refresh of open period failed:', err.message));
    return { payload: hit.payload, cache: 'open-stale', fetchedAt: hit.at };
  }
  const r = await openPull(key, build);
  return { payload: r.payload, cache: 'open-miss', fetchedAt: r.at };
}

async function getWithMonthCache({ site, start, end, compare, refresh }, build) {
  if (!isClosedFullMonth(start, end)) return getOpenPeriod({ site, start, end, compare, refresh }, build);

  const compareKey = [...compare].sort().join(',');
  const key = [site, start, end, compareKey].join('|');
  const args = { site, start, end, compareKey };

  if (!refresh) {
    let row = null;
    try {
      row = await readCache(site, start, end, compareKey);
    } catch (err) {
      console.error('month-cache: read failed:', err.message);
    }
    if (row) {
      const ageHours = (Date.now() - new Date(row.fetched_at).getTime()) / 3600000;
      const recentlyClosed = daysSince(end) <= REFRESH_WINDOW_DAYS;
      // 2026-10-26: a month stored before the Discounts Breakdown got its
      // "Yotpo Loyalty" row (discounts_version < 2) is served as-is once and
      // re-pulled in the background, so it picks the row up by itself. Raised to
      // 3 the same day for the Yotpo Bday / Ref rows and discount groups.
      // 4 (2026-10-28): program discounts by discount application.
      // A month stored while Triple Whale or the P&L sheet was down
      // (partial_sources, 2026-10-29) is re-pulled — at most once a day.
      const partial = row.payload && Array.isArray(row.payload.partial_sources) && row.payload.partial_sources.length > 0 && ageHours > 24;
      // 5 (2026-11-02): the Discounts Breakdown's own Total row.
      // 6 (2026-11-02): ATTENTIVE group + TikTok Shop discounts line.
      // 7 (2026-11-02): ATTENTIVE removed again (discounts_programs_total).
      // 8 (2026-11-04): discount_split (five buckets).
      // 9 (2026-11-04): Discount Ratio in the split; BDAY codes in any case.
      // 10 (2026-11-04): $0.10 points check only in the store's currency.
      // 11 (2026-11-04): SALES box from the Evergreen Discounts Tags sheet.
      // 12 (2026-11-04): VAT out of the split for VAT-inclusive stores (IL).
      // 13 (2026-11-04): voided orders' discounts in the split.
      // 14 (2026-11-04): VAT out line by line (Shopify's own method).
      // 15 (2026-11-04): Discounts split valued at retail.
      // 16 (2026-11-04): Gross Sales of the whole orders in the split.
      // 17 (2026-11-05): whole prior month in MoM; more outages flagged.
      // 18 (2026-11-05): Samples broken down by product.
      const outdated = !(row.payload && row.payload.discounts_version >= 18) || partial;
      if (recentlyClosed && ageHours > STALE_AFTER_HOURS) {
        pullAndStore(key, args, build).catch((err) => console.error('month-cache: background refresh failed:', err.message));
        return { payload: row.payload, cache: 'stale', fetchedAt: row.fetched_at };
      }
      if (outdated) {
        // One upgrade pull at a time across the whole server, so opening
        // Year-to-Date doesn't start ~27 heavy Shopify pulls at once.
        if (!inFlight.has(key) && !upgradeQueued.has(key)) {
          upgradeQueued.add(key);
          upgradeChain = upgradeChain
            .then(() => pullAndStore(key, args, build))
            .catch((err) => console.error('month-cache: upgrade refresh failed:', err.message))
            .finally(() => upgradeQueued.delete(key));
        }
        return { payload: row.payload, cache: 'stale', fetchedAt: row.fetched_at };
      }
      return { payload: row.payload, cache: 'hit', fetchedAt: row.fetched_at };
    }
  }

  const payload = await pullAndStore(key, args, build);
  return { payload, cache: refresh ? 'refresh' : 'miss' };
}

module.exports = { ensureMonthCacheSchema, getWithMonthCache, isClosedFullMonth };
