// TikTok Shop Open API — direct connection (added 2026-10-28).
//
// Why: Tomer wants the TikTok Affiliates revenue to be EXACTLY TikTok
// Affiliate Center → Performance → "Creator-attributed GMV". Neither Windsor
// nor Triple Whale has that metric; Windsor's order / statement data only
// gets within ±3% (TikTok attributes per item, and only the items a creator
// actually promoted). TikTok's own Affiliate Seller API returns every
// affiliate order with the attributed SKUs, which is what the Affiliate
// Center adds up:
//   POST /affiliate_seller/202410/orders/search   (scope seller.affiliate_collaboration.read)
//
// Setup (Tomer, once — secrets never go through chat):
//   1. TikTok Shop Partner Center → create a custom app for the ND US shop
//      with the "Read Seller Affiliate Collaboration" scope; set its redirect
//      URL to https://nd-dashboard-backend.onrender.com/tiktok-shop/callback
//   2. Render env vars: TIKTOK_APP_KEY, TIKTOK_APP_SECRET, TIKTOK_SERVICE_ID
//   3. Open /admin/tiktok/connect?token=<ADMIN_SETUP_TOKEN> and approve.
// The access / refresh tokens are kept in Postgres (tiktok_api_auth) and
// refreshed automatically; they're never shown or logged.

const crypto = require('crypto');
const { getPool } = require('./yotpo');

const API_BASE = 'https://open-api.tiktokglobalshop.com';
const AUTH_BASE = 'https://auth.tiktok-shops.com';
// US shops authorize on services.us.tiktokshop.com; overridable in case
// TikTok's authorization link (Partner Center → app → Authorization) differs.
const AUTHORIZE_URL = process.env.TIKTOK_AUTHORIZE_URL || 'https://services.us.tiktokshop.com/open/authorize';
// Affiliate Center reports in fixed GMT-8 all year (no daylight saving) —
// confirmed 28 Oct: daily items sold match TikTok's trend chart only on GMT-8 days.
const TZ = 'Etc/GMT+8';
const DATA_V = 5; // v5 (29 Oct): buyer shipping, order-level discounts, unpaid orders out (see orderAmounts)
const REQUEST_TIMEOUT_MS = 60000;

const num = (v) => Number(v || 0);
const isoOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s));
const plusDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

function configured() {
  return !!(process.env.TIKTOK_APP_KEY && process.env.TIKTOK_APP_SECRET);
}

// ---- storage ---------------------------------------------------------------
let schemaReady = null;
function ensureSchema() {
  const p = getPool();
  if (!p) return Promise.resolve(false);
  if (!schemaReady) {
    schemaReady = p.query(`
      CREATE TABLE IF NOT EXISTS tiktok_api_auth (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS tiktok_affiliate_days (
        day DATE PRIMARY KEY,
        data JSONB NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );`).then(() => true).catch((err) => {
      console.error('tiktok-api: schema failed:', err.message);
      schemaReady = null;
      return false;
    });
  }
  return schemaReady;
}
let memAuth = null;
async function loadAuth() {
  const p = getPool();
  if (p && (await ensureSchema())) {
    const { rows } = await p.query(`SELECT data FROM tiktok_api_auth WHERE id = 'shop'`);
    if (rows[0]) return rows[0].data;
  }
  return memAuth;
}
async function saveAuth(data) {
  memAuth = data;
  const p = getPool();
  if (p && (await ensureSchema())) {
    await p.query(`INSERT INTO tiktok_api_auth (id, data, updated_at) VALUES ('shop', $1, now())
      ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [JSON.stringify(data)]);
  }
}

// ---- OAuth -----------------------------------------------------------------
const pendingStates = new Map(); // state -> expiry (ms)
function authorizeUrl() {
  if (!process.env.TIKTOK_SERVICE_ID) throw new Error('TIKTOK_SERVICE_ID is not set on the server');
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now() + 15 * 60000);
  return `${AUTHORIZE_URL}?service_id=${encodeURIComponent(process.env.TIKTOK_SERVICE_ID)}&state=${state}`;
}
function checkState(state) {
  const exp = pendingStates.get(String(state || ''));
  pendingStates.delete(String(state || ''));
  return !!exp && exp > Date.now();
}
async function tokenRequest(path, params) {
  const qs = new URLSearchParams({ app_key: process.env.TIKTOK_APP_KEY, app_secret: process.env.TIKTOK_APP_SECRET, ...params });
  const res = await fetch(`${AUTH_BASE}${path}?${qs.toString()}`, { signal: AbortSignal.timeout(30000) });
  const json = await res.json().catch(() => null);
  if (!json || json.code !== 0 || !json.data || !json.data.access_token) {
    throw new Error(`TikTok token request failed: ${json ? (json.message || json.code) : 'HTTP ' + res.status}`); // never includes secrets
  }
  const d = json.data;
  return {
    access_token: d.access_token,
    access_expires: num(d.access_token_expire_in), // unix seconds (expiry time)
    refresh_token: d.refresh_token,
    refresh_expires: num(d.refresh_token_expire_in),
    seller_name: d.seller_name || null,
    seller_base_region: d.seller_base_region || null,
    granted_scopes: d.granted_scopes || [],
  };
}
async function exchangeCode(code) {
  const t = await tokenRequest('/api/v2/token/get', { auth_code: code, grant_type: 'authorized_code' });
  const auth = { ...t, connected_at: new Date().toISOString(), shop_cipher: null, shop_name: null };
  await saveAuth(auth);
  // Shop cipher right away, so a wrong shop shows up at connect time.
  try { await shopCipher(auth); } catch (err) { console.error('tiktok-api: shop lookup failed:', err.message); }
  return loadAuth();
}
let refreshing = null;
async function accessToken() {
  let auth = await loadAuth();
  if (!auth || !auth.access_token) { const e = new Error('TikTok Shop API isn\'t connected yet'); e.status = 503; throw e; }
  const now = Date.now() / 1000;
  if (auth.access_expires && auth.access_expires - now < 86400) {
    if (!refreshing) {
      refreshing = tokenRequest('/api/v2/token/refresh', { refresh_token: auth.refresh_token, grant_type: 'refresh_token' })
        .then(async (t) => { const next = { ...auth, ...t, refreshed_at: new Date().toISOString() }; await saveAuth(next); return next; })
        .finally(() => { refreshing = null; });
    }
    auth = await refreshing;
  }
  return auth;
}

// ---- signed API calls --------------------------------------------------------
// TikTok Shop signature: app_secret + path + (sorted query key+value, without
// sign / access_token) + body + app_secret, HMAC-SHA256 with app_secret, hex.
function sign(path, query, bodyStr) {
  const secret = process.env.TIKTOK_APP_SECRET;
  const keys = Object.keys(query).filter((k) => k !== 'sign' && k !== 'access_token').sort();
  const base = secret + path + keys.map((k) => k + query[k]).join('') + (bodyStr || '') + secret;
  return crypto.createHmac('sha256', secret).update(base).digest('hex');
}
async function apiCall(method, path, { query = {}, body = null, auth = null, withCipher = true } = {}) {
  auth = auth || (await accessToken());
  const q = { app_key: process.env.TIKTOK_APP_KEY, timestamp: String(Math.floor(Date.now() / 1000)), ...query };
  if (withCipher) q.shop_cipher = await shopCipher(auth);
  const bodyStr = body ? JSON.stringify(body) : '';
  q.sign = sign(path, q, bodyStr);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${path}?${new URLSearchParams(q).toString()}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-tts-access-token': auth.access_token },
      body: body ? bodyStr : undefined,
      signal: controller.signal,
    });
    const json = await res.json().catch(() => null);
    if (!json) throw new Error(`TikTok API ${path}: HTTP ${res.status}, non-JSON response`);
    if (json.code !== 0) { const e = new Error(`TikTok API ${path}: ${json.message || 'error'} (code ${json.code})`); e.code = json.code; throw e; }
    return json.data || {};
  } finally {
    clearTimeout(timer);
  }
}
async function shopCipher(auth) {
  if (auth.shop_cipher) return auth.shop_cipher;
  const data = await apiCall('GET', '/authorization/202309/shops', { auth, withCipher: false });
  const shops = data.shops || [];
  const shop = shops.find((s) => String(s.region || '').toUpperCase() === 'US') || shops[0];
  if (!shop) throw new Error('No TikTok shop is authorized for this app');
  const next = { ...auth, shop_cipher: shop.cipher, shop_name: shop.name || null, shop_id: shop.id || null, shop_region: shop.region || null };
  await saveAuth(next);
  return shop.cipher;
}

// ---- affiliate orders ----------------------------------------------------------
const tzFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const ptDay = (sec) => tzFmt.format(new Date(sec * 1000));
// Unix seconds of 00:00 GMT-8 on an ISO day (TikTok Affiliate Center days).
function ptMidnight(iso) {
  return Date.parse(iso + 'T08:00:00Z') / 1000; // 00:00 GMT-8
}
const money = (o) => (o && o.amount !== undefined ? num(o.amount) : 0);

// TikTok's Creator-attributed GMV per order = what the buyer paid for the
// attributed items (after every discount, incl. order-level vouchers the SKU
// price doesn't show) + the shipping fee the buyer paid. Matched to the cent
// against the Affiliate Center for Oct 21–27 2026 (per day and per creator).
// The API has neither shipping nor order-level vouchers, so they come from
// Triple Whale's TikTok Shop orders (order_id = TikTok order id).
// Checked 29 Oct against TikTok's daily figures for Sep 29 – Oct 27:
//  • an order cancelled exactly 1 hour after it was placed is TikTok's
//    auto-cancel of an UNPAID order — TikTok leaves it out entirely
//    (paid-then-cancelled orders stay in, as TikTok counts them);
//  • when the order also has items the API doesn't list (e.g. a free gift)
//    and the API's SKU value is above the order's net, TikTok counts the net.
const UNPAID_CANCEL_SECS = [3590, 3620];
async function orderAmounts(ids, startDay, endDay) {
  const out = new Map();
  if (!ids.length || !process.env.TRIPLEWHALE_API_KEY) return { map: out, ok: false };
  const { TW_SHOP_ID, twSqlRequest } = require('./triplewhale');
  const from = plusDays(startDay, -1), to = plusDays(endDay, 2);
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200).filter((x) => /^\d+$/.test(x));
    if (!chunk.length) continue;
    const query = `SELECT order_id, SUM(gross_product_sales - discount_amount_for_product) AS net, SUM(shipping_price) AS ship, SUM(product_quantity_sold_in_order) AS qty,
      max(if(fulfillment_status = 'CANCELLED', toInt64(toUnixTimestamp(cancelled_at)) - toInt64(toUnixTimestamp(created_at)), -1)) AS cancel_secs
      FROM orders_table WHERE event_date >= '${from}' AND event_date < '${to}' AND platform = 'tiktok-shops'
      AND order_id IN (${chunk.map((x) => `'${x}'`).join(',')}) GROUP BY order_id`;
    const res = await twSqlRequest(TW_SHOP_ID.com, query, from, to);
    if (!res.ok) throw new Error(`Triple Whale SQL ${res.status}`);
    const json = await res.json();
    const rows = Array.isArray(json) ? json : json.rows || json.data || [];
    rows.forEach((r) => out.set(String(r.order_id), { net: num(r.net), ship: num(r.ship), qty: num(r.qty), cancelSecs: r.cancel_secs === null || r.cancel_secs === undefined ? -1 : num(r.cancel_secs) }));
  }
  return { map: out, ok: true };
}

// Every affiliate SKU order created in [startDay, endDay) GMT-8, bucketed by
// day. gmv = Creator-attributed GMV (see orderAmounts); items_gmv = Σ SKU
// price × quantity from the API alone, plus commission and refund figures.
async function pullDays(startDay, endDay) {
  const ge = ptMidnight(startDay), lt = ptMidnight(endDay);
  const days = new Map();
  const blank = () => ({ v: DATA_V, gmv: 0, items_gmv: 0, shipping: 0, order_adjust: 0, unpaid_excluded: 0, tw_missing: 0, tw_error: false, price_sum: 0, commission_base: 0, est_commission: 0, est_partner_commission: 0, est_ads_commission: 0, refunded_value: 0, orders: 0, skus: 0, ineligible_gmv: 0, by_content: {} });
  for (let d = startDay; d < endDay; d = plusDays(d, 1)) days.set(d, blank());
  let pageToken = '', pages = 0;
  // TikTok can return one order as several entries (its SKUs split across
  // results, seen 29 Oct) — merge them so the order is matched to Triple
  // Whale once, with all its attributed SKUs.
  const perOrder = new Map();
  do {
    const data = await apiCall('POST', '/affiliate_seller/202410/orders/search', {
      query: { page_size: '100', ...(pageToken ? { page_token: pageToken } : {}) },
      body: { create_time_ge: ge, create_time_lt: lt },
    });
    (data.orders || []).forEach((o) => {
      const day = ptDay(num(o.create_time));
      const b = days.get(day);
      if (!b) return;
      const id = String(o.id || '') || `noid-${perOrder.size}`;
      let po = perOrder.get(id);
      if (!po) { po = { id, day, value: 0, qty: 0 }; perOrder.set(id, po); b.orders++; }
      (o.skus || []).forEach((s) => {
        const price = money(s.price), qty = num(s.quantity) || 1, v = price * qty;
        po.value += v; po.qty += qty;
        b.skus++;
        b.items_gmv += v;
        b.price_sum += price;
        b.commission_base += money(s.estimated_commission_base);
        b.est_commission += money(s.estimated_paid_commission);
        b.est_partner_commission += money(s.estimated_paid_partner_commission);
        b.est_ads_commission += money(s.estimated_paid_shop_ads_commission);
        b.refunded_value += price * num(s.refunded_quantity);
        if (String(s.settlement_status || '').toUpperCase() === 'INELIGIBLE') b.ineligible_gmv += v;
        const ct = String(s.content_type || 'OTHER').toUpperCase();
        b.by_content[ct] = (b.by_content[ct] || 0) + v;
      });
    });
    pageToken = data.next_page_token || '';
    pages++;
  } while (pageToken && pages < 2000);
  let tw = { map: new Map(), ok: false };
  try { tw = await orderAmounts([...perOrder.keys()], startDay, endDay); } catch (err) { console.error('tiktok-api: shipping lookup failed:', err.message); }
  perOrder.forEach((po) => {
    const b = days.get(po.day);
    const t = tw.map.get(po.id);
    if (!t) { b.gmv += po.value; b.tw_missing++; if (!tw.ok) b.tw_error = true; return; }
    if (t.cancelSecs >= UNPAID_CANCEL_SECS[0] && t.cancelSecs <= UNPAID_CANCEL_SECS[1]) {
      b.unpaid_excluded += po.value; b.orders--; return; // never paid
    }
    if (po.qty >= t.qty || po.value >= t.net - 0.005) {
      // the whole order is creator-attributed (or its net is below the API's
      // SKU value): the order's own net after every discount
      b.gmv += t.net + t.ship; b.shipping += t.ship; b.order_adjust += t.net - po.value;
    } else {
      // other paid items in the order too: the attributed SKUs + their share of shipping
      const share = t.net > 0 ? Math.min(1, po.value / t.net) : 1;
      b.gmv += po.value + t.ship * share; b.shipping += t.ship * share;
    }
  });
  days.forEach((b) => { ['gmv', 'items_gmv', 'shipping', 'order_adjust', 'unpaid_excluded'].forEach((k) => { b[k] = Math.round(b[k] * 100) / 100; }); });
  return days;
}

const memDays = new Map();
async function readDays(from, to) {
  const out = new Map();
  memDays.forEach((v, d) => { if (d >= from && d < to) out.set(d, v); });
  const p = getPool();
  if (p && (await ensureSchema())) {
    const { rows } = await p.query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, data, fetched_at FROM tiktok_affiliate_days WHERE day >= $1 AND day < $2`, [from, to]);
    rows.forEach((r) => out.set(r.day, { data: r.data, fetched_at: new Date(r.fetched_at).getTime() }));
  }
  return out;
}
async function writeDays(days) {
  const items = [...days.entries()].map(([day, data]) => ({ day, data }));
  items.forEach((x) => memDays.set(x.day, { data: x.data, fetched_at: Date.now() }));
  const p = getPool();
  if (!items.length || !p || !(await ensureSchema())) return;
  await p.query(`INSERT INTO tiktok_affiliate_days (day, data, fetched_at)
    SELECT (x->>'day')::date, x->'data', now() FROM jsonb_array_elements($1::jsonb) AS x
    ON CONFLICT (day) DO UPDATE SET data = EXCLUDED.data, fetched_at = now()`, [JSON.stringify(items)]);
}

// How long a saved day is trusted: recent days still change (attribution,
// late orders), older ones barely.
function maxAgeMs(day, todayPT) {
  const age = (Date.parse(todayPT) - Date.parse(day)) / 86400000;
  if (age <= 1) return 30 * 60000;          // today / yesterday: 30 min
  if (age <= 14) return 6 * 3600000;        // last two weeks: 6 h
  if (age <= 60) return 24 * 3600000;       // last two months: daily
  return 30 * 24 * 3600000;                 // older: monthly
}

const inFlight = new Map();
// [start, end) in GMT-8 days. Returns totals + per-day figures.
async function getCreatorGmv(start, end) {
  if (!isoOk(start) || !isoOk(end) || end <= start) { const e = new Error('start and end must be YYYY-MM-DD with end after start'); e.status = 400; throw e; }
  if (!configured()) { const e = new Error('TikTok Shop API isn\'t configured on the server'); e.status = 503; throw e; }
  const todayPT = ptDay(Date.now() / 1000);
  const last = end <= plusDays(todayPT, 1) ? end : plusDays(todayPT, 1);
  const saved = await readDays(start, last);
  const stale = [];
  for (let d = start; d < last; d = plusDays(d, 1)) {
    const s = saved.get(d);
    // Days whose orders weren't all in Triple Whale yet (it syncs TikTok orders
    // with a lag) are re-checked hourly for a week.
    const recentDay = Date.parse(todayPT) - Date.parse(d) <= 7 * 86400000;
    const recheck = s && s.data && (s.data.tw_error ? Date.parse(todayPT) - Date.parse(d) <= 60 * 86400000 : (num(s.data.tw_missing) > 0 && recentDay));
    if (!s || num(s.data && s.data.v) !== DATA_V || Date.now() - s.fetched_at > (recheck ? 3600000 : maxAgeMs(d, todayPT))) stale.push(d);
  }
  // Pull the stale days as contiguous spans (one paginated search each; the
  // API allows up to ~3 months per request).
  const spans = [];
  stale.forEach((d) => { const sp = spans[spans.length - 1]; if (sp && sp[1] === d && Date.parse(d) - Date.parse(sp[0]) < 80 * 86400000) sp[1] = plusDays(d, 1); else spans.push([d, plusDays(d, 1)]); });
  for (const [a, b] of spans) {
    const k = a + '|' + b;
    if (!inFlight.has(k)) inFlight.set(k, pullDays(a, b).then(async (days) => { await writeDays(days); return days; }).finally(() => inFlight.delete(k)));
    const days = await inFlight.get(k);
    days.forEach((data, d) => saved.set(d, { data, fetched_at: Date.now() }));
  }
  const keys = ['gmv', 'items_gmv', 'shipping', 'order_adjust', 'unpaid_excluded', 'tw_missing', 'price_sum', 'commission_base', 'est_commission', 'est_partner_commission', 'est_ads_commission', 'refunded_value', 'orders', 'skus', 'ineligible_gmv'];
  const total = Object.fromEntries(keys.map((k) => [k, 0]));
  const byDay = [];
  for (let d = start; d < last; d = plusDays(d, 1)) {
    const s = saved.get(d);
    if (!s) continue;
    keys.forEach((k) => { total[k] += num(s.data[k]); });
    byDay.push({ day: d, gmv: num(s.data.gmv), items_gmv: num(s.data.items_gmv), shipping: num(s.data.shipping), orders: num(s.data.orders) });
  }
  const fetched = [...saved.values()].map((s) => s.fetched_at).filter(Boolean);
  return { source: 'tiktok_affiliate_api', tz: TZ, start, end, through: plusDays(last, -1), ...total, by_day: byDay, oldest_fetch: fetched.length ? new Date(Math.min(...fetched)).toISOString() : null };
}

// Diagnostic (no buyer / creator details): every affiliate SKU line created in
// [start, end) as a flat row of its numeric, money and enum fields, so the
// dashboard figure can be matched to TikTok's Creator-attributed GMV.
// Max 8 days per call.
function flatten(obj, prefix, row) {
  Object.entries(obj || {}).forEach(([k, v]) => {
    const key = prefix + k;
    if (v === null || v === undefined || k === 'skus') return;
    if (typeof v === 'object' && !Array.isArray(v)) {
      if (v.amount !== undefined) row[key] = num(v.amount);
      else flatten(v, key + '.', row);
    } else if (typeof v === 'number' || typeof v === 'boolean') row[key] = v;
    else if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && v.length < 14) row[key] = Number(v);
    else if (typeof v === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(v)) row[key] = v;
  });
  return row;
}
// raw=1: the orders as TikTok returns them, minus anything about the buyer.
const REDACT_RE = /buyer|address|phone|email|recipient|avatar/i;
function redact(v) {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !REDACT_RE.test(k)).map(([k, x]) => [k, redact(x)]));
  return v;
}
async function diagRows(start, end, raw = false) {
  if (!isoOk(start) || !isoOk(end) || end <= start || Date.parse(end) - Date.parse(start) > 8 * 86400000) { const e = new Error('start/end: YYYY-MM-DD, at most 8 days'); e.status = 400; throw e; }
  if (!configured()) { const e = new Error('TikTok Shop API isn\'t configured on the server'); e.status = 503; throw e; }
  // Pad a day on each side so any day boundary (PT or GMT-8) can be applied later.
  const ge = ptMidnight(plusDays(start, -1)), lt = ptMidnight(plusDays(end, 1));
  const rows = [], firstPage = {};
  let pageToken = '', pages = 0, orders = 0;
  do {
    const data = await apiCall('POST', '/affiliate_seller/202410/orders/search', {
      query: { page_size: '100', ...(pageToken ? { page_token: pageToken } : {}) },
      body: { create_time_ge: ge, create_time_lt: lt },
    });
    if (!pages) Object.keys(data).forEach((k) => { if (k !== 'orders') firstPage[k] = typeof data[k] === 'object' ? '[object]' : data[k]; });
    (data.orders || []).forEach((o) => {
      orders++;
      if (raw) { rows.push(redact(o)); return; }
      const base = flatten(o, 'o.', { oi: orders });
      if (!(o.skus || []).length) rows.push({ ...base, no_skus: true });
      (o.skus || []).forEach((s) => rows.push(flatten(s, '', { ...base })));
    });
    pageToken = data.next_page_token || '';
    pages++;
  } while (pageToken && pages < 200);
  delete firstPage.next_page_token;
  return { start, end, padded_from: ge, padded_to: lt, pages, orders, first_page: firstPage, rows };
}

async function status() {
  const auth = await loadAuth().catch(() => null);
  return {
    configured: configured(),
    service_id_set: !!process.env.TIKTOK_SERVICE_ID,
    connected: !!(auth && auth.access_token),
    seller_name: auth ? auth.seller_name : null,
    shop_name: auth ? auth.shop_name : null,
    shop_region: auth ? auth.shop_region : null,
    granted_scopes: auth ? auth.granted_scopes : [],
    access_expires: auth && auth.access_expires ? new Date(auth.access_expires * 1000).toISOString() : null,
    refresh_expires: auth && auth.refresh_expires ? new Date(auth.refresh_expires * 1000).toISOString() : null,
    connected_at: auth ? auth.connected_at : null,
  };
}

module.exports = { configured, authorizeUrl, checkState, exchangeCode, getCreatorGmv, diagRows, status, _sign: sign, _ptMidnight: ptMidnight };
