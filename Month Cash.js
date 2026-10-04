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
  return end === expectedEnd && end <= todayISO();
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
async function getWithMonthCache({ site, start, end, compare, refresh }, build) {
  if (!isClosedFullMonth(start, end)) return { payload: await build(), cache: 'bypass' };

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
      if (recentlyClosed && ageHours > STALE_AFTER_HOURS) {
        pullAndStore(key, args, build).catch((err) => console.error('month-cache: background refresh failed:', err.message));
        return { payload: row.payload, cache: 'stale', fetchedAt: row.fetched_at };
      }
      return { payload: row.payload, cache: 'hit', fetchedAt: row.fetched_at };
    }
  }

  const payload = await pullAndStore(key, args, build);
  return { payload, cache: refresh ? 'refresh' : 'miss' };
}

module.exports = { ensureMonthCacheSchema, getWithMonthCache, isClosedFullMonth };
