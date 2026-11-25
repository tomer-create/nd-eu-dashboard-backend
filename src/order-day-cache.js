// Per-day cache of Shopify orders, kept in Postgres (added 2026-11-25).
//
// Why: a full month of ND.COM orders is ~96 pages of Shopify GraphQL and takes
// 40–90 s on every pull of the current month (plus 25–60 s for the year-ago
// and month-ago comparison pulls). Almost all of those orders are days old and
// no longer change, yet every pull fetched them again, and every deploy or
// restart started from nothing.
//
// What: shopify.js asks this module for the days it can reuse. Orders are
// stored one row per (site, query, day) as gzipped JSON.
//  - The most recent LIVE_DAYS days are never cached: new orders, refunds and
//    fulfillments (Pick & Pack location) keep changing there.
//  - An older day is reused for a while (TTL) and then pulled again. The TTL
//    is spread per day (jitter) so a pull refreshes only some days, not all.
//    5–35 days old: about 6–18 h. Older than 35 days: about 1.5–4.5 days.
//  - Orders of the full query / voided / tier-revenue queries are only kept
//    for days up to FULL_MAX_AGE_DAYS old (the month in progress plus the
//    month before it); the light query (year-ago / month-ago comparison) is
//    kept for any age, it is small.
// The cache can only make a pull faster: if the database is missing or
// errors, shopify.js pulls from Shopify exactly as before.

const zlib = require('zlib');
const crypto = require('crypto');
const { promisify } = require('util');
const { AsyncLocalStorage } = require('async_hooks');
const { getPool } = require('./yotpo');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const LIVE_DAYS = 5;            // today and the 5 days before it are always pulled live
const MID_AGE_DAYS = 35;
const MID_TTL_MS = 12 * 3600 * 1000;
const OLD_TTL_MS = 3 * 24 * 3600 * 1000;
const FULL_MAX_AGE_DAYS = 70;   // full / voided / tier queries are only stored this far back
const PRUNE_FULL_AFTER_DAYS = 80;
const PRUNE_LIGHT_AFTER_DAYS = 430;
const MAX_RANGE_DAYS = 62;      // longer ranges are pulled the old way

const DAY_MS = 86400000;

// Sync's "orders=fresh": ignore stored days for this request (and store the
// fresh pull). AsyncLocalStorage carries it down to the order pulls.
const ctx = new AsyncLocalStorage();
function withFreshOrders(fn) { return ctx.run({ fresh: true }, fn); }
function isFresh() { const s = ctx.getStore(); return !!(s && s.fresh); }

let schemaReady = null;
function ensureSchema() {
  const p = getPool();
  if (!p) return Promise.resolve(false);
  if (!schemaReady) {
    schemaReady = p
      .query(`
        CREATE TABLE IF NOT EXISTS order_day_cache (
          site TEXT NOT NULL,
          qkey TEXT NOT NULL,
          kind TEXT NOT NULL,
          day DATE NOT NULL,
          n INTEGER NOT NULL,
          payload BYTEA NOT NULL,
          fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (site, qkey, day)
        );
      `)
      .then(() => true)
      .catch((err) => {
        console.error('order-day-cache: schema migration failed:', err.message);
        schemaReady = null;
        return false;
      });
  }
  return schemaReady;
}

function enabled() {
  return !!process.env.DATABASE_URL && process.env.ORDER_DAY_CACHE !== 'off';
}

function qkeyOf(query, voided) {
  return crypto.createHash('sha1').update(String(query)).update('|' + (voided ? 'v' : 'n')).digest('hex').slice(0, 20);
}

const todayISO = () => new Date().toISOString().slice(0, 10);
const dayAge = (dayISO, today) => Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(dayISO + 'T00:00:00Z')) / DAY_MS);

// 'live'  -> pull every time, do not store
// number  -> ttl in ms (store, reuse while younger than this)
// 'skip'  -> too old for this kind of query: pull as before, do not store
function policyFor(kind, dayISO, today) {
  const age = dayAge(dayISO, today);
  if (age <= LIVE_DAYS) return 'live';
  if (kind !== 'light' && age > FULL_MAX_AGE_DAYS) return 'skip';
  const base = age <= MID_AGE_DAYS ? MID_TTL_MS : OLD_TTL_MS;
  // 0.5x .. 1.5x of the base, fixed per day, so the days expire at different times.
  const jitter = 0.5 + ((Math.floor(Date.parse(dayISO + 'T00:00:00Z') / DAY_MS) * 7919) % 100) / 100;
  return Math.round(base * jitter);
}

function listDays(startISO, endISO) {
  const out = [];
  for (let t = Date.parse(startISO + 'T00:00:00Z'); t < Date.parse(endISO + 'T00:00:00Z'); t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

function nextDay(dayISO) {
  return new Date(Date.parse(dayISO + 'T00:00:00Z') + DAY_MS).toISOString().slice(0, 10);
}

// day -> { orders, fetchedAt }
async function readDays(site, qkey, startISO, endISO) {
  const p = getPool();
  if (!p || !(await ensureSchema())) return new Map();
  const { rows } = await p.query(
    'SELECT day::text AS day, payload, fetched_at FROM order_day_cache WHERE site = $1 AND qkey = $2 AND day >= $3 AND day < $4',
    [site, qkey, startISO, endISO]
  );
  const out = new Map();
  await Promise.all(rows.map(async (r) => {
    try {
      const orders = JSON.parse((await gunzip(r.payload)).toString('utf8'));
      if (Array.isArray(orders)) out.set(r.day, { orders, fetchedAt: new Date(r.fetched_at).getTime() });
    } catch (err) {
      console.error(`order-day-cache: unreadable row ${site} ${r.day}:`, err.message);
    }
  }));
  return out;
}

async function writeDay(site, qkey, kind, day, orders) {
  const p = getPool();
  if (!p || !(await ensureSchema())) return;
  const payload = await gzip(Buffer.from(JSON.stringify(orders), 'utf8'));
  await p.query(
    `INSERT INTO order_day_cache (site, qkey, kind, day, n, payload, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (site, qkey, day)
     DO UPDATE SET n = EXCLUDED.n, payload = EXCLUDED.payload, fetched_at = now()`,
    [site, qkey, kind, day, orders.length, payload]
  );
}

let lastPrune = 0;
async function pruneOccasionally() {
  if (Date.now() - lastPrune < 6 * 3600 * 1000) return;
  lastPrune = Date.now();
  const p = getPool();
  if (!p || !(await ensureSchema())) return;
  try {
    await p.query(
      `DELETE FROM order_day_cache
       WHERE (kind <> 'light' AND day < current_date - $1::int)
          OR (kind = 'light' AND day < current_date - $2::int)`,
      [PRUNE_FULL_AFTER_DAYS, PRUNE_LIGHT_AFTER_DAYS]
    );
  } catch (err) {
    console.error('order-day-cache: prune failed:', err.message);
  }
}

module.exports = {
  enabled, qkeyOf, todayISO, policyFor, listDays, nextDay, readDays, writeDay, pruneOccasionally,
  withFreshOrders, isFresh, MAX_RANGE_DAYS, LIVE_DAYS,
};
