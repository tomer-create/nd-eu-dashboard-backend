// TikTok Shop Seller Center data via Windsor.ai — phase 2 of the ND.COM
// TikTok Shop section, added 2026-10-07 after Tomer connected TikTok Shop
// (account "Natasha Denona", id USLCMMEW2K) in Windsor.ai and added
// WINDSOR_API_KEY to Render.
//
// What this adds on top of phase 1 (src/tiktokshop.js, Triple Whale):
//   - Seller Center GMV split by content type: LIVE / video / product card
//   - traffic: product impressions, product page views, daily visitors,
//     buyers — each also split by LIVE / video / product card
//   - TikTok's settlement fees from the payout statements: affiliate
//     commission, affiliate ads commission, referral fee, etc., plus the
//     statement's total fees, revenue and payout
// Not available from Windsor (checked against the full 577-field list):
//   - affiliate vs organic GMV split (Affiliate Center analytics aren't in
//     the connector) — the section keeps "Affiliate + Organic" combined
//   - samples cost (only an is-sample flag on orders) — stays on the P&L
//     sheet's TikTok Gifting row
//
// Validated 2026-10-07 against Triple Whale for Sep 2026:
//   - Windsor FILTERS by the true date but LABELS each Shop Performance row
//     one day late (row "2026-10-01" = Sep 30's 266 orders ≈ Triple Whale's
//     263; row "2026-09-02" = Sep 1's 107 ≈ 110). So date_from/date_to are
//     passed as the real period and the row labels are ignored — only
//     totals are used. Sep orders 4,306 vs Triple Whale 4,290.
//   - Seller Center GMV for Sep = $238,032.51 (LIVE $11,329.33 + video
//     $96,791.65 + product card $129,911.53). This is TikTok's own GMV
//     definition and is lower than Triple Whale's gross product sales
//     ($287,519.35, before discounts) — shown as a separate figure, never
//     mixed with the phase-1 numbers.
//   - Statement fees are by STATEMENT (settlement) date, not order date —
//     they're "fees TikTok settled in this period", labelled as such.
//
// Windsor's REST API is synchronous but slow (a pull can take 1–3 minutes),
// so this is served from its own endpoint (/api/tiktok-shop/seller-center)
// that the dashboard calls in the background — it never slows down Sync.
// Results are cached in Postgres (same DATABASE_URL as Yotpo / month cache):
// a closed period that ended more than 45 days ago is served from cache
// as-is; anything more recent is refreshed in the background once its copy
// is older than 3 hours (stale-while-revalidate).

const { getPool } = require('./yotpo');

const WINDSOR_URL = 'https://connectors.windsor.ai/tiktok_shop';
const WINDSOR_ACCOUNT = 'USLCMMEW2K';
const REQUEST_TIMEOUT_MS = 170000;
const STALE_AFTER_HOURS = 3;
const STABLE_AFTER_DAYS = 45;

const PERF_FIELDS = [
  'date',
  'shop_performance_gmv_amount',
  'shop_performance_gmv_breakdowns_live_amount',
  'shop_performance_gmv_breakdowns_video_amount',
  'shop_performance_gmv_breakdowns_product_card_amount',
  'shop_performance_orders',
  'shop_performance_units_sold',
  'shop_performance_sku_orders',
  'shop_performance_buyers',
  'shop_performance_buyer_breakdowns_live_amount',
  'shop_performance_buyer_breakdowns_video_amount',
  'shop_performance_buyer_breakdowns_product_card_amount',
  'shop_performance_product_impressions',
  'shop_performance_product_impression_breakdowns_live_amount',
  'shop_performance_product_impression_breakdowns_video_amount',
  'shop_performance_product_impression_breakdowns_product_card_amount',
  'shop_performance_product_page_views',
  'shop_performance_product_page_view_breakdowns_live_amount',
  'shop_performance_product_page_view_breakdowns_video_amount',
  'shop_performance_product_page_view_breakdowns_product_card_amount',
  'shop_performance_avg_product_page_visitors',
  'shop_performance_refunds_amount',
  'shop_performance_cancellations_and_returns',
];

// Transaction-level fee lines (Windsor reports them as negative numbers).
// Statement-level totals must be queried separately — Windsor rejects
// mixing the two levels in one call.
const FEE_FIELDS = {
  statement_transaction_fee_affiliate_commission_amount: 'Affiliate commission',
  statement_transaction_fee_affiliate_ads_commission_amount: 'Affiliate ads commission',
  statement_transaction_fee_affiliate_partner_commission_amount: 'Affiliate partner commission',
  statement_transaction_fee_external_affiliate_marketing_fee_amount: 'External affiliate marketing fee',
  statement_transaction_fee_referral_fee_amount: 'Referral fee',
  statement_transaction_fee_platform_commission_amount: 'Platform commission',
  statement_transaction_fee_transaction_fee_amount: 'Transaction fee',
  statement_transaction_fee_gmv_max_ad_fee_amount: 'GMV Max ad fee',
  statement_transaction_fee_smart_promotion_fee_amount: 'Smart promotion fee',
  statement_transaction_fee_refund_administration_fee_amount: 'Refund administration fee',
  statement_transaction_fee_sfp_service_fee_amount: 'SFP service fee',
};
const STATEMENT_FIELDS = [
  'date',
  'statement_revenue_amount',
  'statement_fee_amount',
  'statement_shipping_cost_amount',
  'statement_adjustment_amount',
  'statement_settlement_amount',
];

const num = (v) => Number(v || 0);
const isoOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s));
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function todayISO() { return new Date().toISOString().slice(0, 10); }

async function windsorQuery(fields, dateFrom, dateTo) {
  const key = process.env.WINDSOR_API_KEY;
  const qs = new URLSearchParams({
    api_key: key,
    fields: fields.join(','),
    date_from: dateFrom,
    date_to: dateTo,
    select_accounts: WINDSOR_ACCOUNT,
    _renderer: 'json',
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${WINDSOR_URL}?${qs.toString()}`, { signal: controller.signal });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error(`Windsor ${res.status}: non-JSON response ${text.slice(0, 200)}`); }
    if (!res.ok || json.error) {
      const msg = json.error ? (json.error.message || JSON.stringify(json.error)) : text.slice(0, 200);
      throw new Error(`Windsor ${res.status}: ${msg}`); // never includes the key
    }
    return Array.isArray(json.data) ? json.data : [];
  } finally {
    clearTimeout(timer);
  }
}

function sumRows(rows, field) { return rows.reduce((a, r) => a + num(r[field]), 0); }

// [start, end) — end exclusive like everywhere else in this app.
async function pullSellerCenter(start, end) {
  const dateTo = addDays(end, -1);
  const [perf, fees, statements] = await Promise.all([
    windsorQuery(PERF_FIELDS, start, dateTo),
    windsorQuery(['date', ...Object.keys(FEE_FIELDS)], start, dateTo),
    windsorQuery(STATEMENT_FIELDS, start, dateTo),
  ]);
  const s = (f) => sumRows(perf, 'shop_performance_' + f);
  const days = perf.length;
  const byType = (base) => ({
    live: s(base + '_live_amount'),
    video: s(base + '_video_amount'),
    product_card: s(base + '_product_card_amount'),
  });
  const visitorDays = s('avg_product_page_visitors');
  const feeLines = Object.entries(FEE_FIELDS)
    .map(([field, label]) => ({ key: field.replace('statement_transaction_fee_', '').replace(/_amount$/, ''), label, amount: -sumRows(fees, field) }))
    .filter((l) => Math.abs(l.amount) >= 0.005);
  const totalFees = -sumRows(statements, 'statement_fee_amount');
  const listed = feeLines.reduce((a, l) => a + l.amount, 0);
  return {
    source: 'windsor_tiktok_shop',
    start,
    end,
    days_with_data: days,
    gmv: s('gmv_amount'),
    gmv_by_type: byType('gmv_breakdowns'),
    orders: s('orders'),
    units: s('units_sold'),
    sku_orders: s('sku_orders'),
    buyers: s('buyers'),
    buyers_by_type: byType('buyer_breakdowns'),
    impressions: s('product_impressions'),
    impressions_by_type: byType('product_impression_breakdowns'),
    page_views: s('product_page_views'),
    page_views_by_type: byType('product_page_view_breakdowns'),
    avg_daily_visitors: days ? visitorDays / days : null,
    refunds: s('refunds_amount'),
    cancellations_and_returns: s('cancellations_and_returns'),
    fees: {
      basis: 'statement_date',
      lines: feeLines,
      other: Math.max(0, totalFees - listed),
      total: totalFees,
      statement_revenue: sumRows(statements, 'statement_revenue_amount'),
      shipping: sumRows(statements, 'statement_shipping_cost_amount'),
      adjustments: sumRows(statements, 'statement_adjustment_amount'),
      payout: sumRows(statements, 'statement_settlement_amount'),
      statements: statements.length,
    },
    fetched_at: new Date().toISOString(),
  };
}

// ---- cache -------------------------------------------------------------
let schemaReady = null;
function ensureSchema() {
  const p = getPool();
  if (!p) return Promise.resolve(false);
  if (!schemaReady) {
    schemaReady = p.query(`
      CREATE TABLE IF NOT EXISTS windsor_tiktok_cache (
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        payload JSONB NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (start_date, end_date)
      );`).then(() => true).catch((err) => {
      console.error('windsor-tiktok: schema failed:', err.message);
      schemaReady = null;
      return false;
    });
  }
  return schemaReady;
}
const memCache = new Map(); // fallback when there's no database
async function readCache(start, end) {
  const k = start + '|' + end;
  try {
    const p = getPool();
    if (p && (await ensureSchema())) {
      const { rows } = await p.query('SELECT payload, fetched_at FROM windsor_tiktok_cache WHERE start_date = $1 AND end_date = $2', [start, end]);
      if (rows[0]) return rows[0];
    }
  } catch (err) {
    console.error('windsor-tiktok: cache read failed:', err.message);
  }
  return memCache.get(k) || null;
}
async function writeCache(start, end, payload) {
  memCache.set(start + '|' + end, { payload, fetched_at: new Date().toISOString() });
  try {
    const p = getPool();
    if (p && (await ensureSchema())) {
      await p.query(
        `INSERT INTO windsor_tiktok_cache (start_date, end_date, payload, fetched_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (start_date, end_date) DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()`,
        [start, end, JSON.stringify(payload)]
      );
    }
  } catch (err) {
    console.error('windsor-tiktok: cache write failed:', err.message);
  }
}

const inFlight = new Map();
function pullAndStore(start, end) {
  const k = start + '|' + end;
  if (inFlight.has(k)) return inFlight.get(k);
  const p = pullSellerCenter(start, end)
    .then(async (payload) => { await writeCache(start, end, payload); return payload; })
    .finally(() => inFlight.delete(k));
  inFlight.set(k, p);
  return p;
}

// Returns { payload, cache } or throws { status, message }.
async function getSellerCenter(start, end, { refresh } = {}) {
  if (!process.env.WINDSOR_API_KEY) {
    const e = new Error('WINDSOR_API_KEY is not set on the server'); e.status = 503; throw e;
  }
  if (!isoOk(start) || !isoOk(end) || end <= start) {
    const e = new Error('start and end must be YYYY-MM-DD with end after start'); e.status = 400; throw e;
  }
  if (!refresh) {
    const row = await readCache(start, end);
    if (row) {
      const ageHours = (Date.now() - new Date(row.fetched_at).getTime()) / 3600000;
      const stable = end <= todayISO() && (Date.now() - new Date(end + 'T00:00:00Z').getTime()) / 86400000 > STABLE_AFTER_DAYS;
      if (!stable && ageHours > STALE_AFTER_HOURS) {
        pullAndStore(start, end).catch((err) => console.error('windsor-tiktok: background refresh failed:', err.message));
        return { payload: row.payload, cache: 'stale' };
      }
      return { payload: row.payload, cache: 'hit' };
    }
  }
  const payload = await pullAndStore(start, end);
  return { payload, cache: refresh ? 'refresh' : 'miss' };
}

module.exports = { getSellerCenter, pullSellerCenter };
