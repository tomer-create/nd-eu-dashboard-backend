// TikTok Shop section (ND.COM only) — added 2026-10-07 per Tomer: "on
// ND.COM for TikTok Shop create separate section that need to include
// Affiliate revenue, TikTok ads Revenue, organic revenue, samples cost,
// Affiliate fees cost, and all the breakdown from the Shop analytics on the
// seller center in TikTok shop."
//
// PHASE 1 (this file): everything Triple Whale already receives from the
// TikTok Shop integration on ND.COM, read through the same Data-Out SQL API
// and TRIPLEWHALE_API_KEY that src/triplewhale.js already uses for Section 4.
// No new credentials. Validated 2026-10-07 against Triple Whale's own
// Summary page for Sep 2026 (every figure below matched exactly):
//   - orders_table, platform = 'tiktok-shops' (TikTok's own order record —
//     NOT the Shopify copies with source_name = 'tiktok', which are the same
//     orders synced into Shopify and already counted in ND.COM's Shopify
//     Gross Sales; this section is a breakdown, never added to totals):
//       gross_sales = SUM(gross_product_sales)            $287,519.35
//       sales       = SUM(order_revenue)                  $254,357.23
//       discounts   = product + shipping discounts         $92,726.03
//       orders 4,290 · units 6,933 · new-customer orders 2,923
//   - refunds_table, platform = 'tiktok-shops', by refund date:
//       refunds     = SUM(total_refunded_price)            $19,361.61
//       net_sales   = sales − refunds − taxes              $216,772.56
//   - pixel_joined_tvf, channel = 'tiktok-ads' (Last Click):
//       ads_spend   = SUM(spend)                           $38,380.66
//       ads_revenue = SUM(channel_reported_conversion_value) $73,815.93
//                     (TikTok's own Shop conversion value for its ads)
//   - affiliate_organic_revenue = gross_sales − ads_revenue $213,703.42 —
//     exactly the P&L sheet's "TikTok Organic + Affiliates" figure and Triple
//     Whale's existing custom metric, so it's the same definition Tomer
//     already reports on.
// Affiliate commission and samples cost are NOT here: they come from the P&L
// sheet rows the dashboard already reads (Section 4 "TikTok Affiliates +
// Organic" spend = the sheet's Commission row; Section 7 "TikTok Gifting"),
// combined client-side.
//
// PHASE 2 (not built yet): the Seller Center "Shop Analytics" breakdown
// (GMV by LIVE / video / product card, traffic, affiliate vs organic split,
// TikTok fee lines) via Windsor.ai's TikTok Shop connector, once Tomer
// connects it.
//
// Dates: `end` is EXCLUSIVE everywhere in this app, so every query here uses
// event_date < end (see the matching fix in src/triplewhale.js).

const { TW_SHOP_ID } = require('./triplewhale');

const TRIPLEWHALE_SQL_URL = 'https://api.triplewhale.com/api/v2/orcabase/api/sql';
const SITES_WITH_TIKTOK_SHOP = ['com'];

async function twSql(shopId, query, start, end) {
  const res = await fetch(TRIPLEWHALE_SQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.TRIPLEWHALE_API_KEY },
    body: JSON.stringify({ shopId, query, period: { startDate: start, endDate: end } }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Triple Whale SQL ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  const rows = Array.isArray(json) ? json : json.rows || json.data || [];
  return Array.isArray(rows) ? rows : [];
}

const num = (v) => Number(v || 0);
const isoOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s));

// Totals for one [start, end) period.
async function fetchTotals(shopId, start, end) {
  const range = `event_date >= '${start}' AND event_date < '${end}'`;
  const [orders, refunds, ads] = await Promise.all([
    twSql(shopId, `
      SELECT uniq(order_id) AS orders,
             SUM(gross_product_sales) AS gross_sales,
             SUM(order_revenue) AS sales,
             SUM(taxes) AS taxes,
             SUM(discount_amount_for_product) + SUM(discount_amount_for_shipping) AS discounts,
             SUM(shipping_price) AS shipping,
             SUM(product_quantity_sold_in_order) AS units,
             SUM(if(is_new_customer = 1, 1, 0)) AS new_customer_orders,
             SUM(cost_of_goods) AS cogs
      FROM orders_table
      WHERE ${range} AND platform = 'tiktok-shops'`.trim(), start, end),
    twSql(shopId, `
      SELECT SUM(total_refunded_price) AS refunds
      FROM refunds_table
      WHERE ${range} AND platform = 'tiktok-shops'`.trim(), start, end),
    twSql(shopId, `
      SELECT SUM(spend) AS spend, SUM(channel_reported_conversion_value) AS cv
      FROM pixel_joined_tvf()
      WHERE ${range} AND model = 'Last Click' AND channel = 'tiktok-ads'`.trim(), start, end),
  ]);
  const o = orders[0] || {};
  const gross = num(o.gross_sales);
  const sales = num(o.sales);
  const taxes = num(o.taxes);
  const refundsTotal = num((refunds[0] || {}).refunds);
  const adsRevenue = num((ads[0] || {}).cv);
  return {
    orders: num(o.orders),
    gross_sales: gross,
    sales,
    net_sales: sales - refundsTotal - taxes,
    refunds: refundsTotal,
    discounts: num(o.discounts),
    taxes,
    shipping: num(o.shipping),
    units: num(o.units),
    new_customer_orders: num(o.new_customer_orders),
    cogs: num(o.cogs),
    ads_spend: num((ads[0] || {}).spend),
    ads_revenue: adsRevenue,
    affiliate_organic_revenue: Math.max(0, gross - adsRevenue),
  };
}

async function fetchTopProducts(shopId, start, end) {
  const rows = await twSql(shopId, `
    SELECT p.product_name AS title,
           SUM(p.product_name_price * p.product_name_quantity_sold) AS gross_sales,
           SUM(p.product_name_quantity_sold) AS units
    FROM orders_table ARRAY JOIN products_info AS p
    WHERE event_date >= '${start}' AND event_date < '${end}' AND platform = 'tiktok-shops'
    GROUP BY title
    ORDER BY gross_sales DESC
    LIMIT 10`.trim(), start, end);
  return rows.map((r) => ({ title: r.title, gross_sales: num(r.gross_sales), units: num(r.units) }));
}

const CHANGE_KEYS = ['gross_sales', 'net_sales', 'orders', 'units', 'refunds', 'ads_spend', 'ads_revenue', 'affiliate_organic_revenue', 'new_customer_orders'];
function changes(cur, prev) {
  if (!prev) return null;
  const out = {};
  CHANGE_KEYS.forEach((k) => { out[k] = prev[k] ? (cur[k] - prev[k]) / Math.abs(prev[k]) : null; });
  return out;
}

// Returns the tiktok_shop block for /api/data, or null when the site has no
// TikTok Shop, the API key isn't set, or Triple Whale errors (logged, never
// thrown — this section must never break the rest of a sync).
async function fetchTikTokShop(site, start, end, { yoyRange, momRange } = {}) {
  if (!SITES_WITH_TIKTOK_SHOP.includes(site) || !process.env.TRIPLEWHALE_API_KEY) return null;
  if (!isoOk(start) || !isoOk(end)) return null;
  const shopId = TW_SHOP_ID[site];
  try {
    const [cur, top, yoy, mom] = await Promise.all([
      fetchTotals(shopId, start, end),
      fetchTopProducts(shopId, start, end),
      yoyRange ? fetchTotals(shopId, yoyRange.start, yoyRange.end).catch(() => null) : Promise.resolve(null),
      momRange ? fetchTotals(shopId, momRange.start, momRange.end).catch(() => null) : Promise.resolve(null),
    ]);
    return { source: 'triple_whale', ...cur, top_products: top, yoy: changes(cur, yoy), mom: changes(cur, mom) };
  } catch (err) {
    console.error(`fetchTikTokShop failed for site=${site}:`, err.message);
    return null;
  }
}

module.exports = { fetchTikTokShop, SITES_WITH_TIKTOK_SHOP };
