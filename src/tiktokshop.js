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
//       product_discounts = product discounts only          $55,198.86 (Discount Ratio)
//       orders 4,290 · units 6,933 · new-customer orders 2,923
//   - refunds_table, platform = 'tiktok-shops', by refund date:
//       refunds     = SUM(total_refunded_price)            $19,361.61
//       net_sales   = gross − discounts − refunds          $175,431.71 (since 2026-10-08;
//                     was sales − refunds − taxes = $216,772.56)
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

const { TW_SHOP_ID, twSqlRequest } = require('./triplewhale');

const SITES_WITH_TIKTOK_SHOP = ['com'];

// Goes through the shared Triple Whale queue in src/triplewhale.js (max 2 in
// flight + retry on 429) — see the note there (added 2026-10-07).
async function twSql(shopId, query, start, end) {
  const res = await twSqlRequest(shopId, query, start, end);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Triple Whale SQL ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  const rows = Array.isArray(json) ? json : json.rows || json.data || [];
  return Array.isArray(rows) ? rows : [];
}

// Past periods (YoY, MoM, QoQ comparisons) don't change, so their results are
// kept for PAST_TTL_MS instead of re-queried on every Sync (2026-10-19,
// speeding up Sync). Only ranges that ended at least 3 days ago are kept —
// Triple Whale can still be filling in the last couple of days.
const PAST_TTL_MS = 6 * 60 * 60 * 1000;
const pastCache = new Map(); // key -> { at, value }
function isSettled(end) {
  const cutoff = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  return String(end) <= cutoff;
}
async function cachedPast(key, end, fn) {
  if (!isSettled(end)) return fn();
  const hit = pastCache.get(key);
  if (hit && Date.now() - hit.at < PAST_TTL_MS) return hit.value;
  const value = await fn();
  pastCache.set(key, { at: Date.now(), value });
  if (pastCache.size > 200) pastCache.delete(pastCache.keys().next().value);
  return value;
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
             SUM(discount_amount_for_product) AS product_discounts,
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
      SELECT SUM(spend) AS spend, SUM(channel_reported_conversion_value) AS cv,
             SUM(channel_reported_conversions) AS conversions
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
    // 2026-10-08 per Tomer: same Net Sales definition as the rest of the
    // dashboard — GMV − all discounts − refunds (no tax / shipping). It was
    // order_revenue − refunds − taxes (Triple Whale's TikTok Summary figure),
    // which keeps TikTok-funded discounts in and didn't line up.
    net_sales: gross - num(o.discounts) - refundsTotal,
    net_sales_def: 2,
    refunds: refundsTotal,
    discounts: num(o.discounts),
    // Product discounts only (no shipping discounts) — the TikTok Shop
    // Discount Ratio's numerator since 2026-10-12 per Tomer.
    product_discounts: num(o.product_discounts),
    taxes,
    shipping: num(o.shipping),
    units: num(o.units),
    new_customer_orders: num(o.new_customer_orders),
    cogs: num(o.cogs),
    ads_spend: num((ads[0] || {}).spend),
    ads_revenue: adsRevenue,
    // TikTok's own Shop conversions for its ads (same source as ads_revenue)
    // — the TikTok Ads line's AOV in the dashboard's "Revenue & costs by
    // source" view (2026-10-20).
    ads_orders: num((ads[0] || {}).conversions),
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

// 'shipping' added 2026-10-14: the dashboard's TikTok Shop GMV change uses
// gross + shipping − product discounts (TikTok's GMV formula).
// 'ads_orders' added 2026-10-20 (Revenue & costs by source: TikTok Ads AOV YoY / MoM).
const CHANGE_KEYS = ['gross_sales', 'net_sales', 'orders', 'units', 'refunds', 'discounts', 'product_discounts', 'shipping', 'ads_spend', 'ads_revenue', 'affiliate_organic_revenue', 'new_customer_orders', 'ads_orders'];
function changes(cur, prev) {
  if (!prev) return null;
  const out = {};
  CHANGE_KEYS.forEach((k) => { out[k] = prev[k] ? (cur[k] - prev[k]) / Math.abs(prev[k]) : null; });
  return out;
}

// Returns the tiktok_shop block for /api/data, or null when the site has no
// TikTok Shop, the API key isn't set, or Triple Whale errors (logged, never
// thrown — this section must never break the rest of a sync).
// Prior-period sales for the current top products — added 2026-10-08 (Tomer:
// "for the Top TikTok Shop products, add YOY and MOM"). One query per prior
// range, limited to the top-10 titles; titles are matched exactly (note some
// TikTok titles contain non-breaking spaces, e.g. "EYESHADOW PALETTE").
function sqlStr(t) { return "'" + String(t).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"; }
async function fetchProductGross(shopId, start, end, titles) {
  if (!titles.length) return new Map();
  const rows = await twSql(shopId, `
    SELECT p.product_name AS title,
           SUM(p.product_name_price * p.product_name_quantity_sold) AS gross_sales
    FROM orders_table ARRAY JOIN products_info AS p
    WHERE event_date >= '${start}' AND event_date < '${end}' AND platform = 'tiktok-shops'
      AND p.product_name IN (${titles.map(sqlStr).join(',')})
    GROUP BY title`.trim(), start, end);
  return new Map(rows.map((r) => [r.title, num(r.gross_sales)]));
}
// Same arithmetic as server.js shiftDateRange().
function shiftMonths(range, months) {
  const f = (iso) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - months); return d.toISOString().slice(0, 10); };
  return { start: f(range.start), end: f(range.end) };
}

async function fetchTikTokShop(site, start, end, { yoyRange, momRange } = {}) {
  if (!SITES_WITH_TIKTOK_SHOP.includes(site) || !process.env.TRIPLEWHALE_API_KEY) return null;
  if (!isoOk(start) || !isoOk(end)) return null;
  const shopId = TW_SHOP_ID[site];
  try {
    const [cur, top, yoy, mom] = await Promise.all([
      fetchTotals(shopId, start, end),
      fetchTopProducts(shopId, start, end),
      yoyRange ? cachedPast(`tot|${shopId}|${yoyRange.start}|${yoyRange.end}`, yoyRange.end, () => fetchTotals(shopId, yoyRange.start, yoyRange.end)).catch(() => null) : Promise.resolve(null),
      momRange ? cachedPast(`tot|${shopId}|${momRange.start}|${momRange.end}`, momRange.end, () => fetchTotals(shopId, momRange.start, momRange.end)).catch(() => null) : Promise.resolve(null),
    ]);
    // Prior-period sales per top product (absolute values; the dashboard
    // computes the % so quarters / YTD can add months up first):
    //   yoy_gross   = same period last year
    //   prev_gross  = previous period (MoM range, same length)
    //   prev3_gross = same period 3 months earlier (used for QoQ)
    const titles = top.map((p) => p.title);
    const prior = (range) => (range ? cachedPast(`pg|${shopId}|${range.start}|${range.end}|${titles.join('\u0001')}`, range.end, () => fetchProductGross(shopId, range.start, range.end, titles)).catch(() => null) : Promise.resolve(null));
    const [pYoy, pMom, pQoq] = await Promise.all([prior(yoyRange), prior(momRange), prior(shiftMonths({ start, end }, 3))]);
    top.forEach((p) => {
      if (pYoy) p.yoy_gross = pYoy.get(p.title) || 0;
      if (pMom) p.prev_gross = pMom.get(p.title) || 0;
      if (pQoq) p.prev3_gross = pQoq.get(p.title) || 0;
    });
    return { source: 'triple_whale', ...cur, top_products: top, yoy: changes(cur, yoy), mom: changes(cur, mom) };
  } catch (err) {
    console.error(`fetchTikTokShop failed for site=${site}:`, err.message);
    return null;
  }
}

// TikTok Shop GMV estimate from TikTok's order data in Triple Whale, same
// formula as TikTok's GMV (gross + shipping − product discounts), for
// [start, end). Used to bring TikTok's own analytics GMV (which runs about
// two days behind) up to month-to-date — added 2026-10-14.
async function fetchGmvEstimate(site, start, end) {
  if (!SITES_WITH_TIKTOK_SHOP.includes(site) || !process.env.TRIPLEWHALE_API_KEY) return null;
  if (!isoOk(start) || !isoOk(end) || end <= start) return null;
  const rows = await twSql(TW_SHOP_ID[site], `
    SELECT uniq(order_id) AS orders,
           SUM(gross_product_sales) + SUM(shipping_price) - SUM(discount_amount_for_product) AS gmv
    FROM orders_table
    WHERE event_date >= '${start}' AND event_date < '${end}' AND platform = 'tiktok-shops'`.trim(), start, end);
  const r = rows[0] || {};
  return { start, end, gmv: num(r.gmv), orders: num(r.orders) };
}

// TikTok Gifting cost (2026-10-26, Tomer: "take all the $0 orders from
// Channel TikTok and take their product costs, add them together"). The $0
// orders are the creator samples TikTok sends out; they sync into Shopify
// with sales channel TikTok (source_name 'tiktok'). $0 = product total after
// discounts is zero (all of them, as Tomer asked — cancelled ones included).
//
// 2026-10-28 (Tomer: "go by what's inside those $0 orders"; then, the same
// day: "product cost is always 20% of its price, whether Shopify has a cost
// or not — calculate the $0 orders by that, by the quantities and products"):
// cost = 20% × Σ (each product's price × quantity) over everything inside the
// $0 orders — the same 20%-of-price rule as the dashboard's COGS. The products
// and quantities come from Triple Whale (the Shopify orders' line items); the
// price is the line's own price before the 100% discount. A line recorded at
// $0 (6 variants in Oct, e.g. HY-GLAM FOUNDATION) takes that variant's price
// from its other lines, or else from Shopify. Oct 1–28: 303 orders, 731
// units, $28,439 at retail on the priced lines → ≈ $5,700.
const GIFT_COST_PCT = 0.2;
async function shopifyVariantPrices(variantIds) {
  const { graphql } = require('./shopify');
  const out = new Map();
  const ids = [...new Set(variantIds.filter(Boolean).map(String))];
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const data = await graphql('com', `
      query VariantPrices($ids: [ID!]!) {
        nodes(ids: $ids) { ... on ProductVariant { id price compareAtPrice } }
      }`, { ids: batch.map((id) => `gid://shopify/ProductVariant/${id}`) });
    (data.nodes || []).forEach((n) => {
      if (!n || !n.id) return;
      const p = Number(n.price && n.price.amount !== undefined ? n.price.amount : n.price);
      const c = Number(n.compareAtPrice && n.compareAtPrice.amount !== undefined ? n.compareAtPrice.amount : n.compareAtPrice);
      out.set(String(n.id).split('/').pop(), (Number.isFinite(p) && p > 0) ? p : (Number.isFinite(c) && c > 0 ? c : null));
    });
  }
  return out;
}
async function fetchGifting(site, start, end) {
  if (!SITES_WITH_TIKTOK_SHOP.includes(site) || !process.env.TRIPLEWHALE_API_KEY) return null;
  if (!isoOk(start) || !isoOk(end) || end <= start) return null;
  const shopId = TW_SHOP_ID[site];
  return cachedPast(`gift3|${shopId}|${start}|${end}`, end, async () => {
    const where = `event_date >= '${start}' AND event_date < '${end}'
        AND platform = 'shopify' AND source_name = 'tiktok'
        AND gross_product_sales - discount_amount_for_product <= 0.005`;
    const [tot, lines] = await Promise.all([
      twSql(shopId, `
        SELECT count() AS orders,
               SUM(product_quantity_sold_in_order) AS units,
               SUM(gross_product_sales) AS retail_value
        FROM orders_table
        WHERE ${where}`.trim(), start, end),
      twSql(shopId, `
        SELECT p.variant_id AS variant_id, any(p.product_name) AS name,
               SUM(toFloat64(ifNull(p.product_name_quantity_sold, 0))) AS units,
               SUM(toFloat64(ifNull(p.product_name_price, 0)) * toFloat64(ifNull(p.product_name_quantity_sold, 0))) AS priced_value,
               SUM(if(ifNull(p.product_name_price, 0) > 0, 0, toFloat64(ifNull(p.product_name_quantity_sold, 0)))) AS units_no_price,
               max(toFloat64(ifNull(p.product_name_price, 0))) AS max_price
        FROM orders_table ARRAY JOIN products_info AS p
        WHERE ${where}
        GROUP BY variant_id`.trim(), start, end),
    ]);
    const r = tot[0] || {};
    // Prices for lines recorded at $0 whose variant has no priced line here.
    const needShopify = lines.filter((l) => num(l.units_no_price) > 0 && !(num(l.max_price) > 0)).map((l) => l.variant_id);
    let shopPrices = new Map(), shopifyError = null;
    if (needShopify.length) {
      try { shopPrices = await shopifyVariantPrices(needShopify); } catch (err) { shopifyError = err.message; console.error('gifting: Shopify prices failed:', err.message); }
    }
    let retail = 0, unpriced = 0;
    const missing = [];
    lines.forEach((l) => {
      retail += num(l.priced_value);
      const n0 = num(l.units_no_price);
      if (!n0) return;
      const ref = num(l.max_price) > 0 ? num(l.max_price) : num(shopPrices.get(String(l.variant_id)));
      if (ref > 0) retail += n0 * ref;
      else { unpriced += n0; missing.push(`${l.name} (${n0})`); }
    });
    return {
      start, end,
      cost: retail * GIFT_COST_PCT,
      cost_rule: '20% of price',
      cost_pct: GIFT_COST_PCT,
      retail_value: retail,
      orders: num(r.orders), units: num(r.units),
      units_no_price: unpriced, no_price_items: missing.slice(0, 10),
      ...(shopifyError ? { shopify_error: shopifyError } : {}),
    };
  });
}

module.exports = { fetchTikTokShop, fetchGmvEstimate, fetchGifting, SITES_WITH_TIKTOK_SHOP };
