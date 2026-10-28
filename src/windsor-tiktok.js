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
const REQUEST_TIMEOUT_MS = 240000;
// 12 h (was 3 h): a closed month barely moves, and every refresh is a
// chance for Windsor to hand back a partial answer (2026-10-08 incident).
const STALE_AFTER_HOURS = 12;
const STABLE_AFTER_DAYS = 45;
// Bump when the payload shape changes, so older cached copies are re-pulled.
// v2 (2026-10-07): added affiliate (Affiliate-driven GMV) and samples.
// v3 (2026-10-07 audit): perf_from / perf_error, per-month sample creators,
// bounded statement window.
// v4 (2026-10-07): statement window end+90 days; multi-month periods built from months.
// v5 (2026-10-07): affiliate_with_ads_gmv (measured Ads/Affiliate overlap).
// v6 (2026-10-08): statements pulled in monthly chunks, rows de-duplicated by
// transaction id, refreshes that lose orders are rejected.
// v7 (2026-10-14): perf_partial flag; partial copies refresh after 1 hour.
// Bumped so the partial Oct 1–14 copy saved that morning (8 of 14 days) is
// re-pulled.
// v8 (2026-10-14): core Shop Performance fields pulled on their own (see
// PERF_CORE_FIELDS) — v7 copies have days missing.
// v9 (2026-10-20): affiliate.commission / affiliate.ads_commission (TikTok's
// own affiliate commission on the period's orders, for the dashboard's
// Affiliate commission YoY / MoM). v8 copies stay usable (everything else is
// unchanged): they're served while a background pull upgrades them — see
// COMPAT_MIN_VERSION in getSellerCenter.
// v10 (2026-10-21): sample creators include samples awaiting shipment (see
// pullSampleShipping); v8/v9 copies are served while they're re-pulled.
// v11 (2026-10-28): affiliate.creator_gmv (TikTok Affiliate Center's
// "Creator-attributed GMV" definition, see pullAffiliateGmv), perf_days
// (the real days TikTok's analytics have a figure for) and Shop Performance
// days kept in windsor_tiktok_perf_days so a later partial answer from
// Windsor never loses a day (see mergeStoredDays).
// v12 (2026-10-28): GMV / orders pulled with no other fields (see
// PERF_CORE_FIELDS) — v11 copies made that day have days missing.
const PAYLOAD_VERSION = 12;
const COMPAT_MIN_VERSION = 8;

// Core Shop Performance fields — the ones the dashboard's numbers come from.
// Pulled on their own (2026-10-14): asking Windsor for these together with
// the traffic breakdowns below drops whole days — for Oct 1–14 it returned 8
// of 13 days ($97.5K GMV) with the breakdowns vs all 13 days ($170.6K)
// without them.
// 2026-10-28 (live check after tt75): even these 12 fields made Windsor drop
// days — Oct 1–28 came back with 18 daily rows, while date + GMV + orders
// alone came back with all 26 TikTok had. So the dashboard's figures (GMV,
// orders) are pulled on their own, and the other Shop Performance fields
// (not shown on the dashboard) in a separate, best-effort query.
const PERF_CORE_FIELDS = [
  'date',
  'shop_performance_gmv_amount',
  'shop_performance_orders',
];
const PERF_DETAIL_FIELDS = [
  'date',
  'shop_performance_gmv_breakdowns_live_amount',
  'shop_performance_gmv_breakdowns_video_amount',
  'shop_performance_gmv_breakdowns_product_card_amount',
  'shop_performance_units_sold',
  'shop_performance_buyers',
  'shop_performance_product_impressions',
  'shop_performance_product_page_views',
  'shop_performance_refunds_amount',
  'shop_performance_cancellations_and_returns',
];
// Traffic breakdowns (no longer shown on the dashboard) — separate query, a
// failure or missing days here never touch the core figures.
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

async function windsorQuery(fields, dateFrom, dateTo, filter) {
  const key = process.env.WINDSOR_API_KEY;
  const qs = new URLSearchParams({
    api_key: key,
    fields: fields.join(','),
    date_from: dateFrom,
    date_to: dateTo,
    select_accounts: WINDSOR_ACCOUNT,
    _renderer: 'json',
  });
  if (filter) qs.set('filter', JSON.stringify(filter));
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

// ---- Affiliate-driven GMV + sample shipping (added 2026-10-07 per Tomer) ----
// Affiliate-driven GMV: TikTok doesn't expose Affiliate Center analytics, but
// every order a creator drove carries an affiliate commission in TikTok's
// finance data. So: take every TikTok Shop order placed in the period, from
// the settled statement transactions (order already paid out) plus the
// unsettled transactions (not paid out yet), and sum the gross product
// sales (subtotal before discounts — same basis as Triple Whale's "Gross
// Sales TikTok") of the orders with a non-zero affiliate or affiliate-
// partner commission. Orders whose only affiliate charge is an affiliate ADS
// commission are reported separately (affiliate_ads_only_gmv) — those are
// creator-content ads, so they're already inside the TikTok Ads conversion
// value and would otherwise be counted twice in the Organic formula.
// Order dates are taken in America/New_York, Triple Whale's shop timezone for
// ND.COM, so periods line up with the Triple Whale GMV they're subtracted from.
// Validated 2026-10-07, Sep 2026 settled orders: 3,848 orders, $254,582 gross;
// $143,307 of it affiliate (2,139 orders).
//
// Sample shipping cost, per Tomer's method (Affiliate Center → Analytics →
// Samples): count the creators with at least one sample shipped in the
// period, × $11. Taken from sample orders (order_is_sample_order) placed in
// the period whose status shows they shipped; the creator is the sample
// order's buyer (order_user_id). Validated Sep 2026: 249 sample orders, all
// shipped, to 205 creators → 205 × $11 = $2,255.
// 2026-10-21 (Tomer: "it's based on 156 creators and the real number is 199
// creators from tiktok"): samples approved but still AWAITING_SHIPMENT are
// now counted too — only cancelled sample orders are left out. The shipped-
// only rule undercounted the month in progress: Oct 1–21 had 231 sample
// orders, 44 still awaiting shipment, so 156 creators shipped vs 191 with a
// sample (TikTok's Samples page showed 199 — requests not yet turned into
// orders, or the latest hours, aren't in TikTok's order data via Windsor).
const SAMPLE_SHIPPING_PER_CREATOR = 11;
const ORDER_TZ = 'America/New_York';
const SHIPPED_STATUSES = new Set(['AWAITING_COLLECTION', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED']);
const SETTLED_FIELDS = [
  'statement_transaction_id',
  'statement_transaction_order_id',
  'statement_transaction_order_create_datetime',
  'statement_transaction_type',
  'statement_transaction_revenue_subtotal_before_discount_amount',
  'statement_transaction_revenue_seller_discount_amount',
  'statement_transaction_fee_affiliate_commission_amount',
  'statement_transaction_fee_affiliate_partner_commission_amount',
  'statement_transaction_fee_affiliate_ads_commission_amount',
];
const UNSETTLED_FIELDS = [
  'unsettled_transaction_id',
  'unsettled_transaction_order_id',
  'unsettled_transaction_order_create_datetime',
  'unsettled_transaction_type',
  'unsettled_transaction_revenue_subtotal_before_discount_amount',
  'unsettled_transaction_revenue_seller_discount_amount',
  'unsettled_transaction_fee_affiliate_commission_amount',
  'unsettled_transaction_fee_affiliate_partner_commission_amount',
  'unsettled_transaction_fee_affiliate_ads_commission_amount',
];
const SAMPLE_FIELDS = ['order_id', 'order_create_datetime', 'order_is_sample_order', 'order_user_id', 'order_status', 'order_rts_datetime'];

const tzDay = new Intl.DateTimeFormat('en-CA', { timeZone: ORDER_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
function orderDay(dt) {
  if (!dt) return null;
  const d = new Date(dt);
  return isNaN(d) ? null : tzDay.format(d); // YYYY-MM-DD
}
// TikTok's Affiliate Center reports in Pacific time (GMT-8 / -7).
const CREATOR_TZ = 'America/Los_Angeles';
const tzDayPT = new Intl.DateTimeFormat('en-CA', { timeZone: CREATOR_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
function orderDayPT(dt) {
  if (!dt) return null;
  const d = new Date(dt);
  return isNaN(d) ? null : tzDayPT.format(d);
}
const truthy = (v) => v === true || v === 'True' || v === 'true' || v === 1 || v === '1';

async function pullAffiliateGmv(start, end) {
  const today = todayISO();
  // Orders settle a few weeks after delivery, so statements from the period
  // start to 90 days after its end cover them (60 days missed ~1% of July). (Audit 2026-10-07: scanning
  // every statement up to today made May/Jun time out at 240 s.)
  const settledTo = addDays(end, 90) < today ? addDays(end, 90) : today;
  // Pulled in one-month chunks (2026-10-08): a single Aug 1 → Oct 8 request
  // came back with about half of August's orders missing — Windsor appears to
  // cut very large answers short. Chunks keep every answer small.
  const chunks = monthSlices(start, addDays(settledTo, 1));
  const settledParts = [];
  for (let i = 0; i < chunks.length; i += 3) {
    const batch = await Promise.all(chunks.slice(i, i + 3).map(([a, b]) => windsorQuery(SETTLED_FIELDS, a, addDays(b, -1))));
    batch.forEach((rows) => settledParts.push(...rows));
  }
  const unsettled = await windsorQuery(UNSETTLED_FIELDS, addDays(start, -7), today);
  // De-duplicate by transaction id — the same transaction can come back
  // twice (2026-10-08: September's TikTok order gross jumped from $286.8K to
  // $301.2K on a refresh with the same 4,244 orders).
  const dedupe = (rows, idField) => {
    const seen = new Set();
    return rows.filter((r) => { const id = r[idField]; if (!id) return true; const k = String(id); if (seen.has(k)) return false; seen.add(k); return true; });
  };
  const settled = dedupe(settledParts, 'statement_transaction_id');
  // Each order is kept when its New York day (the dashboard's day, used for
  // everything below except creator_gmv) or its Pacific day (TikTok Affiliate
  // Center's day, used for creator_gmv) falls in the period.
  const orders = new Map(); // order id -> { gross, net, aff, affAds, settled, ny, pt }
  const inRange = (d) => d && d >= start && d < end;
  const add = (prefix, rows, isSettled) => {
    rows.forEach((r) => {
      if (String(r[prefix + 'type'] || 'ORDER') !== 'ORDER') return;
      const id = String(r[prefix + 'order_id'] || '');
      const created = r[prefix + 'order_create_datetime'];
      const ny = inRange(orderDay(created)), pt = inRange(orderDayPT(created));
      if (!id || (!ny && !pt)) return;
      if (!isSettled && orders.has(id) && orders.get(id).settled) return; // settled copy wins
      const cur = (orders.get(id) && orders.get(id).settled === isSettled) ? orders.get(id) : { gross: 0, net: 0, aff: 0, affAds: 0, settled: isSettled, ny, pt };
      const gross = num(r[prefix + 'revenue_subtotal_before_discount_amount']);
      cur.gross += gross;
      // Seller discount comes back negative; the sign is normalised.
      cur.net += gross - Math.abs(num(r[prefix + 'revenue_seller_discount_amount']));
      cur.aff += Math.abs(num(r[prefix + 'fee_affiliate_commission_amount'])) + Math.abs(num(r[prefix + 'fee_affiliate_partner_commission_amount']));
      cur.affAds += Math.abs(num(r[prefix + 'fee_affiliate_ads_commission_amount']));
      orders.set(id, cur);
    });
  };
  add('statement_transaction_', settled, true);
  add('unsettled_transaction_', dedupe(unsettled, 'unsettled_transaction_id'), false);
  // affiliate_with_ads_gmv (added 2026-10-07, per Tomer's choice "Remove
  // overlap"): affiliate orders that ALSO paid an affiliate ADS commission —
  // i.e. ads run on the creator's content. TikTok counts these in its Ads
  // conversion value too, so the dashboard takes them out of TTS Ads to stop
  // them being subtracted twice in Organic GMV.
  let gmv = 0, n = 0, adsOnly = 0, adsOnlyN = 0, total = 0, settledN = 0, both = 0, bothN = 0, commission = 0, adsCommission = 0, seen = 0;
  // Creator-attributed GMV (2026-10-28, Tomer: Affiliates Revenue must equal
  // TikTok Affiliate Center → Performance → "Creator-attributed GMV"):
  // product price before discounts − seller discount, for every order that
  // paid an affiliate or affiliate-partner commission, by the order's
  // Pacific-time day. Checked 28 Oct for Oct 1–25: TikTok $192,620.68 vs
  // $198,528 here (+3.1%) — TikTok counts only the items a creator sold, so
  // an order mixing a creator's item with other items counts in full here.
  // No scaling, no overlap subtraction: the dashboard shows it as is.
  let cGmv = 0, cN = 0, cAds = 0, cAdsN = 0;
  orders.forEach((o) => {
    if (o.pt && o.aff > 0) { cGmv += o.net; cN++; if (o.affAds > 0) { cAds += o.net; cAdsN++; } }
    if (!o.ny) return;
    seen++;
    total += o.gross;
    commission += o.aff; adsCommission += o.affAds;
    if (o.settled) settledN++;
    if (o.aff > 0) { gmv += o.gross; n++; if (o.affAds > 0) { both += o.gross; bothN++; } } else if (o.affAds > 0) { adsOnly += o.gross; adsOnlyN++; }
  });
  return {
    gmv, orders: n,
    affiliate_ads_only_gmv: adsOnly, affiliate_ads_only_orders: adsOnlyN,
    affiliate_with_ads_gmv: both, affiliate_with_ads_orders: bothN,
    orders_seen: seen, orders_settled: settledN, gross_seen: total,
    // Affiliate + partner commission / affiliate ads commission on these
    // orders (by order date, settled or estimated) — added 2026-10-20.
    commission, ads_commission: adsCommission,
    creator_gmv: cGmv, creator_orders: cN,
    creator_with_ads_gmv: cAds, creator_with_ads_orders: cAdsN,
    creator_tz: CREATOR_TZ,
  };
}

async function pullSampleShipping(start, end) {
  // date_to = end (one extra day): an order placed late in the evening New York
  // time on the last day is already the next day in UTC. Filtered by the
  // New York order date below.
  const rows = await windsorQuery(SAMPLE_FIELDS, start, end, [['order_is_sample_order', 'eq', true]]);
  // Creators are counted per calendar month (New York time) and summed, so a
  // quarter / YTD equals the sum of its months — a creator who received
  // samples in July and again in August is two shipments, $11 each. (Audit
  // 2026-10-07: counting distinct creators across Q3 gave 419 vs 511 for the
  // three months added up.)
  const creators = new Map(); // creator -> samples (whole period)
  const creatorMonths = new Set(); // 'YYYY-MM|creator'
  let shipped = 0, awaiting = 0;
  rows.forEach((r) => {
    if (!truthy(r.order_is_sample_order)) return;
    const day = orderDay(r.order_create_datetime);
    if (!day || day < start || day >= end) return;
    const status = String(r.order_status || '').toUpperCase();
    if (/CANCEL/.test(status) || !r.order_user_id) return;
    if (!SHIPPED_STATUSES.has(status) && !r.order_rts_datetime) awaiting++;
    shipped++;
    creators.set(r.order_user_id, (creators.get(r.order_user_id) || 0) + 1);
    creatorMonths.add(day.slice(0, 7) + '|' + r.order_user_id);
  });
  return {
    creators: creatorMonths.size,
    creators_distinct: creators.size,
    samples_shipped: shipped, // all non-cancelled sample orders (incl. awaiting shipment)
    samples_awaiting_shipment: awaiting,
    per_creator: SAMPLE_SHIPPING_PER_CREATOR,
    cost: creatorMonths.size * SAMPLE_SHIPPING_PER_CREATOR,
  };
}

function sumRows(rows, field) { return rows.reduce((a, r) => a + num(r[field]), 0); }

// Shop Performance + statement fees. Windsor refuses the whole request when
// it starts before the TikTok shop's "start of operations" (audit 2026-10-07:
// Jan–Apr 2026 all failed, May onward worked), so on that error retry from
// the 1st of each following month until one works, and report perf_from.
// Any other error is returned as perfError — affiliate GMV and samples are
// pulled separately and still load.
const START_OF_OPS_RE = /start of operations/i;
async function pullShopPerformance(start, dateTo, coreTo) {
  const tryFrom = async (from) => {
    const [perf, detail, traffic, fees, statements] = await Promise.all([
      // 2026-10-28: asked through `end` (one more day): Windsor's date filter
      // turned out to apply to the row LABEL (Oct 1–28 returned labels Oct
      // 1–28 = real Sep 30–Oct 27; label Oct 1 = 266 orders / $15.8K ≈ Triple
      // Whale's Sep 30, 263 / $15.6K). Rows are kept by real day (label − 1)
      // in mergeStoredDays, so the extra day is either the period's last real
      // day or dropped — right whichever way Windsor filters.
      windsorQuery(PERF_CORE_FIELDS, from, coreTo || dateTo),
      windsorQuery(PERF_DETAIL_FIELDS, from, dateTo).catch((err) => { console.error('windsor-tiktok: shop performance details failed:', err.message); return []; }),
      windsorQuery(PERF_FIELDS, from, dateTo).catch((err) => { console.error('windsor-tiktok: traffic breakdowns failed:', err.message); return []; }),
      windsorQuery(['date', ...Object.keys(FEE_FIELDS)], from, dateTo),
      windsorQuery(STATEMENT_FIELDS, from, dateTo),
    ]);
    return { perf, detail, traffic, fees, statements, perfFrom: from, perfError: null };
  };
  let from = start;
  for (let i = 0; i < 13; i++) {
    try {
      return await tryFrom(from);
    } catch (err) {
      if (!START_OF_OPS_RE.test(err.message)) {
        console.error('windsor-tiktok: shop performance failed:', err.message);
        return { perf: [], fees: [], statements: [], perfFrom: null, perfError: err.message };
      }
      const d = new Date(from + 'T00:00:00Z');
      const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
      if (next > dateTo) break;
      from = next;
    }
  }
  return { perf: [], fees: [], statements: [], perfFrom: null, perfError: 'TikTok Shop performance data isn\'t available for this period (before the shop\'s start of operations in Windsor).' };
}

// Partial-answer check for Shop Performance (2026-10-14): Windsor sometimes
// hands back only part of the days early in the (UTC) day — 14 Oct 07:00 the
// Oct 1–14 pull had 8 daily rows / $111K vs 13 rows / $170.6K later. A
// payload with clearly fewer daily rows than days in the period (TikTok's
// analytics run about a day behind, so 2 days of slack) is flagged
// perf_partial: it's refreshed after 1 hour instead of 12, and a refresh
// never replaces a copy that has more days.
function perfPartial(from, end, days, perfError) {
  if (perfError) return false;
  const last = end < addDays(todayISO(), 1) ? end : addDays(todayISO(), 1);
  const expected = Math.round((new Date(last + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 86400000);
  return days < expected - 2;
}
const PARTIAL_STALE_HOURS = 1;
// Last real day with TikTok GMV in the rows. Windsor labels Shop Performance
// rows one day late (see the note at the top), so the real day is the
// label − 1. 14 Oct: last non-zero label 10-13 → data through Oct 12, which
// matches the Oct 1–12 total ($170,587.68).
function perfThrough(rows, end) {
  let last = null;
  for (const r of rows) if (num(r.shop_performance_gmv_amount) > 0 && r.date && (!last || r.date > last)) last = String(r.date).slice(0, 10);
  if (!last) return null;
  const real = addDays(last, -1);
  const cap = addDays(end, -1);
  return real < cap ? real : cap;
}

// ---- Shop Performance days kept per day (2026-10-28) ----------------------
// Tomer: "TikTok Shop GMV isn't up to date". Each dashboard day has its own
// month-to-date cache key, and Windsor's first answer for it was often
// partial (28 Oct: 18 of 27 days), and one day (Oct 10) never came back at
// all. Every day Windsor does return is now saved by its real day
// (label − 1, see the note at the top) and merged into later pulls, so a
// partial answer no longer drops days that were seen before. Days Windsor
// never returns are filled from TikTok's order data by the endpoint
// (server.js, /api/tiktok-shop/seller-center → fill).
const realDayOf = (r) => (r && r.date ? addDays(String(r.date).slice(0, 10), -1) : null);
const memDays = new Map(); // fallback when there's no database
async function storeDays(rows) {
  const items = rows.map((r) => ({ day: realDayOf(r), row: r })).filter((x) => x.day && num(x.row.shop_performance_gmv_amount) > 0);
  if (!items.length) return;
  items.forEach((x) => memDays.set(x.day, x.row));
  const p = getPool();
  if (!p || !(await ensureSchema())) return;
  await p.query(
    `INSERT INTO windsor_tiktok_perf_days (day, row, fetched_at)
     SELECT (x->>'day')::date, x->'row', now() FROM jsonb_array_elements($1::jsonb) AS x
     ON CONFLICT (day) DO UPDATE SET row = EXCLUDED.row, fetched_at = now()`,
    [JSON.stringify(items)]
  );
}
async function readDays(from, to) {
  const out = new Map();
  memDays.forEach((row, day) => { if (day >= from && day < to) out.set(day, row); });
  const p = getPool();
  if (p && (await ensureSchema())) {
    const { rows } = await p.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, row FROM windsor_tiktok_perf_days WHERE day >= $1 AND day < $2`, [from, to]);
    rows.forEach((r) => out.set(r.day, r.row));
  }
  return out;
}
// Fresh rows win; stored days fill the days this answer is missing. Returns
// the rows re-labelled the Windsor way (real day + 1) so perfThrough works
// unchanged, plus the real days covered.
async function mergeStoredDays(perf, start, end) {
  const fresh = new Map();
  perf.forEach((r) => { const d = realDayOf(r); if (d && d >= start && d < end && num(r.shop_performance_gmv_amount) > 0) fresh.set(d, r); });
  await storeDays([...fresh.values()]).catch((err) => console.error('windsor-tiktok: storing days failed:', err.message));
  const stored = await readDays(start, end).catch((err) => { console.error('windsor-tiktok: reading days failed:', err.message); return new Map(); });
  const merged = new Map(stored);
  fresh.forEach((r, d) => merged.set(d, r));
  const days = [...merged.keys()].sort();
  return {
    rows: days.map((d) => ({ ...merged.get(d), date: addDays(d, 1) })),
    days,
    fromStore: days.filter((d) => !fresh.has(d)).length,
  };
}

// [start, end) — end exclusive like everywhere else in this app.
async function pullSellerCenter(start, end) {
  const dateTo = addDays(end, -1);
  const soft = (p, what) => p.catch((err) => { console.error(`windsor-tiktok: ${what} failed:`, err.message); return { error: err.message }; });
  const [sc, affiliate, samples] = await Promise.all([
    pullShopPerformance(start, dateTo, end),
    soft(pullAffiliateGmv(start, end), 'affiliate GMV'),
    soft(pullSampleShipping(start, end), 'sample shipping'),
  ]);
  const { fees, statements } = sc;
  let { perfFrom, perfError } = sc;
  // Saved days only cover days at/after the shop's start of operations, so
  // they're merged from perfFrom (or the period start when Windsor failed
  // outright — then the saved days stand in for the answer).
  const startOfOpsMiss = !!perfError && START_OF_OPS_RE.test(perfError);
  const mergeFrom = perfFrom || (startOfOpsMiss ? null : start);
  const mergedDays = mergeFrom ? await mergeStoredDays(sc.perf, mergeFrom, end) : { rows: sc.perf, days: [], fromStore: 0 };
  if (perfError && !startOfOpsMiss && mergedDays.days.length) {
    console.error(`windsor-tiktok: shop performance failed for ${start}..${end}; using ${mergedDays.days.length} saved days`);
    perfFrom = start; perfError = null;
  }
  const perf = mergedDays.rows;
  const traffic = sc.traffic || [];
  // No shop data at all for the period AND no sample orders: TikTok simply has
  // no history that far back — report samples as unavailable, not as $0.
  const samplesOut = (!perf.length && perfError && samples && !samples.error && samples.samples_shipped === 0)
    ? { error: 'No TikTok sample data for this period' } : samples;
  const s = (f) => sumRows(perf, 'shop_performance_' + f);
  // Details (not on the dashboard) from their own query — may miss days.
  const detail = sc.detail || [];
  const dsum = (f) => sumRows(detail, 'shop_performance_' + f);
  const days = perf.length;
  const byType = (base) => ({
    live: dsum(base + '_live_amount'),
    video: dsum(base + '_video_amount'),
    product_card: dsum(base + '_product_card_amount'),
  });
  const t = (f) => sumRows(traffic, 'shop_performance_' + f);
  const visitorDays = t('avg_product_page_visitors');
  const tByType = (base) => ({
    live: t(base + '_live_amount'),
    video: t(base + '_video_amount'),
    product_card: t(base + '_product_card_amount'),
  });
  const feeLines = Object.entries(FEE_FIELDS)
    .map(([field, label]) => ({ key: field.replace('statement_transaction_fee_', '').replace(/_amount$/, ''), label, amount: -sumRows(fees, field) }))
    .filter((l) => Math.abs(l.amount) >= 0.005);
  const totalFees = -sumRows(statements, 'statement_fee_amount');
  const listed = feeLines.reduce((a, l) => a + l.amount, 0);
  return {
    source: 'windsor_tiktok_shop',
    version: PAYLOAD_VERSION,
    start,
    end,
    days_with_data: days,
    perf_through: perfThrough(perf, end),
    // Real days with a TikTok GMV figure (v11) — the endpoint fills any other
    // day from TikTok's order data.
    perf_days: mergedDays.days,
    perf_days_from_store: mergedDays.fromStore,
    perf_partial: perfPartial(perfFrom || start, end, days, perfError),
    perf_from: perfFrom,
    perf_error: perfError,
    gmv: s('gmv_amount'),
    gmv_by_type: byType('gmv_breakdowns'),
    orders: s('orders'),
    units: dsum('units_sold'),
    sku_orders: t('sku_orders'),
    buyers: dsum('buyers'),
    buyers_by_type: tByType('buyer_breakdowns'),
    impressions: dsum('product_impressions'),
    impressions_by_type: tByType('product_impression_breakdowns'),
    page_views: dsum('product_page_views'),
    page_views_by_type: tByType('product_page_view_breakdowns'),
    avg_daily_visitors: traffic.length ? visitorDays / traffic.length : null,
    refunds: dsum('refunds_amount'),
    cancellations_and_returns: dsum('cancellations_and_returns'),
    detail_days: detail.length,
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
    affiliate,
    samples: samplesOut,
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
      );
      CREATE TABLE IF NOT EXISTS windsor_tiktok_perf_days (
        day DATE PRIMARY KEY,
        row JSONB NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
// Refresh guard (2026-10-08): a closed month's order count doesn't shrink, so
// a refresh that finds noticeably fewer TikTok orders than the saved copy is
// a partial answer from Windsor — keep the saved copy instead.
function seenOrders(p) { return p && p.affiliate && !p.affiliate.error ? num(p.affiliate.orders_seen) : 0; }
function pullAndStore(start, end) {
  const k = start + '|' + end;
  if (inFlight.has(k)) return inFlight.get(k);
  const p = pullSellerCenter(start, end)
    .then(async (payload) => {
      const prev = await readCache(start, end).catch(() => null);
      const old = prev && prev.payload;
      const compatible = old && old.version >= COMPAT_MIN_VERSION && old.version <= PAYLOAD_VERSION;
      // Only a copy of the current version is kept over a shorter answer: an
      // older copy (no creator GMV, no saved days) is replaced — the saved
      // days and the endpoint's fill make up for days missing in the new one.
      if (compatible && old.version === PAYLOAD_VERSION && num(old.days_with_data) > num(payload.days_with_data) && !old.perf_error) {
        console.error(`windsor-tiktok: refresh for ${start}..${end} has ${payload.days_with_data} days of shop performance vs ${old.days_with_data} saved — keeping the saved copy`);
        return old;
      }
      if (old && seenOrders(old) > 0 && seenOrders(payload) < seenOrders(old) * 0.95) {
        console.error(`windsor-tiktok: refresh for ${start}..${end} found ${seenOrders(payload)} orders vs ${seenOrders(old)} saved — keeping the saved copy`);
        if (compatible) return old;
      }
      await writeCache(start, end, payload);
      return payload;
    })
    .finally(() => inFlight.delete(k));
  inFlight.set(k, p);
  return p;
}

// Returns { payload, cache } or throws { status, message }.
// ---- multi-month periods (quarters, YTD) --------------------------------
// Audit 2026-10-07: one Windsor request spanning Jan→Oct came back incomplete
// (TikTok order data covered $772K of the $1.5M YTD GMV), and small
// boundary differences meant a quarter didn't exactly equal its months. So a
// period longer than one calendar month is built from its months: each
// month is pulled (and cached) on its own and the results are added up — a
// quarter / YTD equals the sum of its months by construction.
function monthSlices(start, end) {
  const out = [];
  let cur = start;
  while (cur < end) {
    const d = new Date(cur + 'T00:00:00Z');
    const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
    out.push([cur, next < end ? next : end]);
    cur = next;
  }
  return out;
}
const sumKeys = (arr, keys) => Object.fromEntries(keys.map((k) => [k, arr.reduce((a, x) => a + num(x && x[k]), 0)]));
function combinePayloads(start, end, parts) {
  const withPerf = parts.filter((p) => p.days_with_data);
  const out = {
    source: 'windsor_tiktok_shop', version: PAYLOAD_VERSION, start, end, combined_months: parts.length,
    ...sumKeys(parts, ['days_with_data', 'gmv', 'orders', 'units', 'sku_orders', 'buyers', 'impressions', 'page_views', 'refunds', 'cancellations_and_returns']),
    perf_from: (withPerf[0] && withPerf[0].perf_from) || null,
    perf_partial: parts.some((p) => p.perf_partial),
    perf_through: (parts[parts.length - 1] || {}).perf_through || null,
    perf_days: parts.every((p) => Array.isArray(p.perf_days)) ? [].concat(...parts.map((p) => p.perf_days)) : undefined,
    perf_days_from_store: parts.reduce((a, p) => a + num(p.perf_days_from_store), 0),
    perf_error: withPerf.length ? null : ((parts.find((p) => p.perf_error) || {}).perf_error || null),
    fetched_at: parts.map((p) => p.fetched_at).filter(Boolean).sort()[0] || new Date().toISOString(),
  };
  const days = out.days_with_data;
  out.avg_daily_visitors = days ? withPerf.reduce((a, p) => a + num(p.avg_daily_visitors) * num(p.days_with_data), 0) / days : null;
  ['gmv_by_type', 'buyers_by_type', 'impressions_by_type', 'page_views_by_type'].forEach((k) => {
    out[k] = sumKeys(parts.map((p) => p[k] || {}), ['live', 'video', 'product_card']);
  });
  const lines = new Map();
  parts.forEach((p) => ((p.fees && p.fees.lines) || []).forEach((l) => {
    const cur = lines.get(l.key) || { key: l.key, label: l.label, amount: 0 };
    cur.amount += num(l.amount); lines.set(l.key, cur);
  }));
  out.fees = { basis: 'statement_date', lines: [...lines.values()], ...sumKeys(parts.map((p) => p.fees || {}), ['other', 'total', 'statement_revenue', 'shipping', 'adjustments', 'payout', 'statements']) };
  const affErr = parts.find((p) => !p.affiliate || p.affiliate.error);
  out.affiliate = affErr
    ? { error: (affErr.affiliate && affErr.affiliate.error) || 'Affiliate data missing for part of this period' }
    : {
      ...sumKeys(parts.map((p) => p.affiliate), ['gmv', 'orders', 'affiliate_ads_only_gmv', 'affiliate_ads_only_orders', 'affiliate_with_ads_gmv', 'affiliate_with_ads_orders', 'orders_seen', 'orders_settled', 'gross_seen']),
      // commission only when every month has it (v9+ months)
      ...(parts.every((p) => p.affiliate && typeof p.affiliate.commission === 'number') ? sumKeys(parts.map((p) => p.affiliate), ['commission', 'ads_commission']) : {}),
      // creator GMV only when every month has it (v11+ months)
      ...(parts.every((p) => p.affiliate && typeof p.affiliate.creator_gmv === 'number') ? { ...sumKeys(parts.map((p) => p.affiliate), ['creator_gmv', 'creator_orders', 'creator_with_ads_gmv', 'creator_with_ads_orders']), creator_tz: CREATOR_TZ } : {}),
      // Per-month figures so the dashboard can work out the Ads/Affiliate
      // overlap month by month — a quarter's Organic GMV then equals the sum
      // of its months' Organic GMV (audit 2026-10-07).
      by_month: parts.map((p) => ({ start: p.start, gmv: num(p.affiliate.gmv), with_ads: num(p.affiliate.affiliate_with_ads_gmv), gross_seen: num(p.affiliate.gross_seen),
        creator_gmv: typeof p.affiliate.creator_gmv === 'number' ? p.affiliate.creator_gmv : null, creator_with_ads_gmv: num(p.affiliate.creator_with_ads_gmv) })),
    };
  // A month with no TikTok sample history ("No TikTok sample data…") counts as 0;
  // any other sample error makes the period's total unavailable.
  const smpErr = parts.find((p) => !p.samples || (p.samples.error && !/^No TikTok sample data/.test(p.samples.error)));
  const smpOk = parts.filter((p) => p.samples && !p.samples.error);
  out.samples = smpErr ? { error: (smpErr.samples && smpErr.samples.error) || 'Sample data missing for part of this period' }
    : smpOk.length ? { ...sumKeys(smpOk, []), ...sumKeys(smpOk.map((p) => p.samples), ['creators', 'samples_shipped', 'samples_awaiting_shipment', 'cost']), per_creator: SAMPLE_SHIPPING_PER_CREATOR }
    : { error: 'No TikTok sample data for this period' };
  return out;
}

async function getSellerCenter(start, end, { refresh } = {}) {
  if (!process.env.WINDSOR_API_KEY) {
    const e = new Error('WINDSOR_API_KEY is not set on the server'); e.status = 503; throw e;
  }
  if (!isoOk(start) || !isoOk(end) || end <= start) {
    const e = new Error('start and end must be YYYY-MM-DD with end after start'); e.status = 400; throw e;
  }
  const slices = monthSlices(start, end);
  if (slices.length > 1) {
    const results = new Array(slices.length);
    let i = 0;
    const worker = async () => { while (i < slices.length) { const k = i++; results[k] = await getSellerCenter(slices[k][0], slices[k][1], { refresh }); } };
    await Promise.all([worker(), worker(), worker()]);
    const caches = results.map((r) => r.cache);
    return { payload: combinePayloads(start, end, results.map((r) => r.payload)), cache: caches.every((c) => c === 'hit') ? 'hit' : caches.join(',') };
  }
  if (!refresh) {
    const row = await readCache(start, end);
    // An older but compatible copy (v8) is served as-is while a background
    // pull replaces it with the current version.
    if (row && row.payload && row.payload.version >= COMPAT_MIN_VERSION && row.payload.version < PAYLOAD_VERSION) {
      pullAndStore(start, end).catch((err) => console.error('windsor-tiktok: background upgrade failed:', err.message));
      return { payload: row.payload, cache: 'stale' };
    }
    if (row && row.payload && row.payload.version === PAYLOAD_VERSION) {
      const ageHours = (Date.now() - new Date(row.fetched_at).getTime()) / 3600000;
      const stable = end <= todayISO() && (Date.now() - new Date(end + 'T00:00:00Z').getTime()) / 86400000 > STABLE_AFTER_DAYS;
      if (!stable && ageHours > (row.payload.perf_partial ? PARTIAL_STALE_HOURS : STALE_AFTER_HOURS)) {
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
