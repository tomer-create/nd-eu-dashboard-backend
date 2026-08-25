require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { fetchOrders, fetchOrdersLight, fetchSalesReversals, fetchCostOfGoodsSold, fetchTopReturnsByProduct, fetchCountryBreakdown, fetchSalesSummary, getAuthorizeUrl, exchangeCodeForToken } = require('./src/shopify');
const { aggregate } = require('./src/aggregate');

const app = express();
const PORT = process.env.PORT || 3000;

// Render sits behind a proxy — trust its X-Forwarded-Proto so req.protocol
// reports "https" (needed to build a correct OAuth redirect_uri below).
app.set('trust proxy', true);

// Lock this down to the dashboard's actual origin once you know it
// (e.g. https://claude.site or wherever the artifact/desktop app serves it
// from). Comma-separated list in ALLOWED_ORIGINS, "*" allows any origin.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());
app.use(
  cors({
    origin: allowedOrigins.includes('*') ? true : allowedOrigins,
  })
);
app.use(express.json());

const VALID_SITES = ['com', 'eu', 'il'];

// --- One-time-per-store authorization (Authorization Code Grant) ---
//
// Visit /auth/<route> once per store, approve the Shopify screen, and
// /auth/callback will show you a permanent access token to copy into
// Render as SHOPIFY_<SITE>_ACCESS_TOKEN. See README.md.
//
// ROUTE_TO_SITE maps the URL segment used in the browser (what a scanner
// like Google Safe Browsing sees) to this app's internal site key (used for
// the SHOPIFY_<SITE>_* env var lookups everywhere else, incl. /api/data and
// /api/sync). Israel's real route is "co.il" rather than the bare "il" used
// internally — /auth/il had been getting flagged by Google Safe Browsing as
// a suspected phishing redirect, and "co.il" (matching the store's actual
// natashadenona.co.il ccTLD) avoids that specific pattern without touching
// any of the SHOPIFY_IL_* env var names.
const ROUTE_TO_SITE = { com: 'com', eu: 'eu', 'co.il': 'il' };

// IMPORTANT: /auth/callback is a literal path and must be registered BEFORE
// the /auth/:route wildcard below — Express matches routes in registration
// order, so if :route came first it would swallow "callback" as a route
// segment and the real callback handler would never run.
app.get('/auth/callback', async (req, res) => {
  const { code, state: site } = req.query;
  if (!code || !site) {
    return res.status(400).send('Missing code or state in callback — start again at /auth/<site>.');
  }
  try {
    const token = await exchangeCodeForToken(site, code);
    res.send(`<!doctype html><html><body style="font-family:sans-serif;max-width:640px;margin:60px auto;line-height:1.5">
      <h2>Authorization complete for "${site}"</h2>
      <p>Copy this token and add it to Render as <code>SHOPIFY_${site.toUpperCase()}_ACCESS_TOKEN</code>, then you can close this tab. It does not expire — this is a one-time step per store.</p>
      <textarea readonly style="width:100%;height:80px;font-family:monospace;font-size:13px;padding:8px">${token}</textarea>
    </body></html>`);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get('/auth/:route', (req, res) => {
  const { route } = req.params;
  const site = ROUTE_TO_SITE[route];
  if (!site) {
    return res.status(400).send(`Unknown site "${route}". Must be one of: ${Object.keys(ROUTE_TO_SITE).join(', ')}`);
  }
  const redirectUri = `${req.protocol}://${req.get('host')}/auth/callback`;
  try {
    res.redirect(getAuthorizeUrl(site, redirectUri));
  } catch (err) {
    res.status(500).send(err.message);
  }
});

function shiftDateRange(startISO, endISO, { years = 0, months = 0 } = {}) {
  const start = new Date(startISO + 'T00:00:00Z');
  const end = new Date(endISO + 'T00:00:00Z');
  start.setUTCFullYear(start.getUTCFullYear() - years);
  end.setUTCFullYear(end.getUTCFullYear() - years);
  start.setUTCMonth(start.getUTCMonth() - months);
  end.setUTCMonth(end.getUTCMonth() - months);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

function pctChange(curr, prev) {
  if (!prev) return null;
  return (curr - prev) / Math.abs(prev);
}

// Per-site fixed-percentage COGS override — added 2026-08-25 per Tomer's
// request ("on ND.IL COGS should be calculated as 30% out of the gross
// sales"). ND.IL's live ShopifyQL cost_of_goods_sold pull relies on each
// product variant having a "cost per item" set in Shopify admin (see the
// note on fetchCostOfGoodsSold in src/shopify.js) — Tomer's request implies
// that isn't reliably populated for this store, so rather than keep
// reporting an understated/zeroed live figure, ND.IL's COGS is now a fixed
// 30% of Gross Sales instead. Keyed by site so another store can get the
// same treatment later without touching the call sites below — sites not
// listed here are unaffected and keep using the live ShopifyQL figure.
const COGS_PCT_OF_GROSS = { il: 0.3 };

// Resolves the COGS figure to report for a period: the fixed-percentage
// override for sites in COGS_PCT_OF_GROSS above (computed off that SAME
// period's own corrected gross_sales, so YoY/MoM comparisons stay apples-
// to-apples), or the live ShopifyQL cost_of_goods_sold pull for every other
// site, unchanged from before.
function resolveCogs(site, grossSales, shopifyCogs) {
  const pct = COGS_PCT_OF_GROSS[site];
  if (pct != null) return grossSales * pct;
  return shopifyCogs;
}

app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Pulls fresh Shopify data for [start, end) and returns it in the shape the
// dashboard's renderers expect. Shared by both the GET lookup (used when
// switching dates) and the POST sync (used by the "Sync" button).
async function buildDataResponse({ site, start, end, compare }) {
  if (!site || !VALID_SITES.includes(site)) {
    const err = new Error(`site must be one of: ${VALID_SITES.join(', ')}`);
    err.status = 400;
    throw err;
  }
  if (!start || !end) {
    const err = new Error('start and end (YYYY-MM-DD) are required');
    err.status = 400;
    throw err;
  }

  const wantYoy = compare.includes('yoy');
  const wantMom = compare.includes('mom');
  const yoyRange = wantYoy ? shiftDateRange(start, end, { years: 1 }) : null;
  const momRange = wantMom ? shiftDateRange(start, end, { months: 1 }) : null;

  // YTD range for Section 3's "Return Ratio (YTD)" column — added 2026-08-25
  // per Tomer's request to fix it for ND.EU. Until now the live-sync path
  // hardcoded return_ratio_ytd to null (see mergeLiveIntoMonthData in
  // dashboard_v2.html), showing "—" for every site except ND.COM, which has
  // a one-time hand-pulled YTD snapshot baked into the dashboard's embedded
  // data. "YTD" here means Jan 1 through the same end boundary as the
  // selected period — derived from the last INCLUDED day (end minus 1,
  // since `end` itself is exclusive) rather than `end` directly, so this
  // still means the right year if a sync range ever crossed midnight UTC.
  const lastIncludedDate = new Date(end + 'T00:00:00Z');
  lastIncludedDate.setUTCDate(lastIncludedDate.getUTCDate() - 1);
  const ytdStart = `${lastIncludedDate.getUTCFullYear()}-01-01`;

  // Fetch the current period plus both comparison periods concurrently —
  // they're independent Shopify queries. The comparison periods use
  // fetchOrdersLight (a much cheaper GraphQL query — see shopify.js) since
  // only gross sales + order count are read off them below; the full
  // per-order detail (line items, refunds, shipping address, tags) is only
  // needed for the current period's top_products/by_country/discounts.
  // Confirmed via direct testing (2026-08-24): the full-detail query for all
  // 3 periods concurrently was taking ~60s end to end, right at the edge of
  // (and sometimes past) the dashboard's timeout — this cuts the GraphQL
  // cost of 2 of those 3 fetches substantially, which also means less
  // Shopify rate-limit contention between the concurrent requests.
  //
  // Returns for all 3 periods come from fetchSalesReversals (Shopify's own
  // ShopifyQL "sales_reversals" metric) rather than from the orders queries
  // above — confirmed 2026-08-24 that the Orders-API refunds approach
  // (attributed by order CREATION date) undercounts Shopify's own reported
  // returns by ~69%, because Shopify attributes a sales reversal by the
  // REFUND date instead.
  //
  // COGS for all 3 periods comes from fetchCostOfGoodsSold (ShopifyQL's own
  // "cost_of_goods_sold" metric) — added 2026-08-24 per Tomer's request
  // ("the COGS number isn't correct, you should pull it from Shopify as
  // well"). Previously COGS on the dashboard came only from the P&L Google
  // Sheet with no live-sync path. Both this and the sales_reversals calls
  // are single-aggregate ShopifyQL queries (not paginated per-order like
  // fetchOrders/fetchOrdersLight), so they're cheap — adding 3 more of them
  // here doesn't meaningfully add to the latency that made the sync-timeout
  // fix necessary.
  //
  // topReturns (added 2026-08-24) is a 10th call in the same Promise.all,
  // for the CURRENT period only -- Section 3 "Top Return Products" never had
  // any live-sync path before this (see fetchTopReturnsByProduct in
  // src/shopify.js for why it doesn't just reuse the refunds already fetched
  // by ORDERS_QUERY). It's another single ShopifyQL aggregate call (capped
  // at 15 rows server-side via LIMIT), so it's cheap the same way the
  // reversals/COGS calls are.
  //
  // countryBreakdown (added 2026-08-24, calls 11-13) replaces the by_country
  // that used to come from aggregate() — Tomer reported ND.EU's Sales by
  // Country section "show[ing] the country by name and not by country code,
  // also ... Return Rate, YOY, MOM" not showing. aggregate()'s by_country
  // only ever had a raw shippingAddress.countryCode and gross_sales/orders
  // (see src/aggregate.js) — no real net sales, no returns, and obviously no
  // YoY/MoM since aggregate() never sees a comparison period. ShopifyQL's
  // `GROUP BY billing_country` gives full country display names AND can
  // report net_sales/sales_reversals/orders in the same query — see
  // fetchCountryBreakdown in src/shopify.js. Fetched for current/yoy/mom just
  // like the reversals/COGS calls, so YoY/MoM can be computed per country the
  // same way attachChangeByKey already does for products.
  //
  // ytdTopReturns (added 2026-08-25, call 14) is a YTD-scoped call to the
  // same fetchTopReturnsByProduct used for the period-ranked topReturns list
  // below — see the ytdStart comment above. LIMIT 250 here (vs. 15 for the
  // period-ranked list) so this YTD pull is virtually certain to cover every
  // product that makes the period's top 15, even though this table stays
  // ranked by the SELECTED period's return $ value, not YTD (matching this
  // live path's existing behavior — only the ratio column's scope changes,
  // not the ranking). ND.EU's full catalog is well under 250 distinct titles
  // sold in a year, so this shouldn't silently truncate.
  //
  // salesSummary calls (added 2026-08-25, calls 15-17) pull Shopify's own
  // authoritative gross_sales/discounts/orders totals via `FROM sales SHOW`
  // ShopifyQL — see fetchSalesSummary in src/shopify.js for the full
  // rationale (replaces the earlier approach of reconstructing these figures
  // by including/excluding individual orders, which got the wrong answer
  // twice in one day). Same cheap single-aggregate-call shape as the
  // reversals/COGS calls, so this doesn't add meaningful latency.
  //
  // All 17 Shopify calls run in one Promise.all so none of this adds extra
  // wall-clock time on top of the orders fetches.
  const [
    orders,
    yoyOrders,
    momOrders,
    currentReversals,
    yoyReversals,
    momReversals,
    currentCogs,
    yoyCogs,
    momCogs,
    topReturns,
    ytdTopReturns,
    currentCountryResult,
    yoyCountryResult,
    momCountryResult,
    currentSalesSummary,
    yoySalesSummary,
    momSalesSummary,
  ] = await Promise.all([
    fetchOrders(site, start, end),
    wantYoy ? fetchOrdersLight(site, yoyRange.start, yoyRange.end) : Promise.resolve(null),
    wantMom ? fetchOrdersLight(site, momRange.start, momRange.end) : Promise.resolve(null),
    fetchSalesReversals(site, start, end),
    wantYoy ? fetchSalesReversals(site, yoyRange.start, yoyRange.end) : Promise.resolve(null),
    wantMom ? fetchSalesReversals(site, momRange.start, momRange.end) : Promise.resolve(null),
    fetchCostOfGoodsSold(site, start, end),
    wantYoy ? fetchCostOfGoodsSold(site, yoyRange.start, yoyRange.end) : Promise.resolve(null),
    wantMom ? fetchCostOfGoodsSold(site, momRange.start, momRange.end) : Promise.resolve(null),
    fetchTopReturnsByProduct(site, start, end),
    fetchTopReturnsByProduct(site, ytdStart, end, 250),
    fetchCountryBreakdown(site, start, end),
    wantYoy ? fetchCountryBreakdown(site, yoyRange.start, yoyRange.end) : Promise.resolve(null),
    wantMom ? fetchCountryBreakdown(site, momRange.start, momRange.end) : Promise.resolve(null),
    fetchSalesSummary(site, start, end),
    wantYoy ? fetchSalesSummary(site, yoyRange.start, yoyRange.end) : Promise.resolve(null),
    wantMom ? fetchSalesSummary(site, momRange.start, momRange.end) : Promise.resolve(null),
  ]);

  // fetchCountryBreakdown now returns { rows, groupedBy, fallbackReason? }
  // instead of a bare array — added 2026-08-25 when Tomer asked for Sales by
  // Country to use the shipping address instead of billing (see the big
  // comment on fetchCountryBreakdown in src/shopify.js for why this needs a
  // try-shipping/fall-back-to-billing shape rather than a straight rename).
  // Unwrap here so the rest of this function reads exactly like before.
  const currentCountry = currentCountryResult.rows;
  const yoyCountry = yoyCountryResult ? yoyCountryResult.rows : null;
  const momCountry = momCountryResult ? momCountryResult.rows : null;

  const current = applySalesReversals(applySalesSummary(aggregate(orders), currentSalesSummary), currentReversals);
  current.kpis.cogs = resolveCogs(site, current.kpis.gross_sales, currentCogs);
  const result = { site, start, end, ...current };

  // Attach each period-ranked product's YTD return ratio by matching on
  // exact product title against the YTD list above — same "no stable ID"
  // caveat as attachChangeByKey below. A product with no YTD returns match
  // (brand new this period, or a title that doesn't appear in the YTD list
  // for some other reason) gets null rather than a misleading number.
  const ytdReturnsByTitle = new Map((ytdTopReturns || []).map((r) => [r.title, r]));
  result.top_returns = topReturns.map((r) => {
    const ytd = ytdReturnsByTitle.get(r.title);
    return {
      ...r,
      return_ratio_ytd: ytd && ytd.gross_sales ? ytd.return_value / ytd.gross_sales : null,
    };
  });
  // Reassigned below as YoY/MoM per-product comparisons are computed —
  // starts as the current period's own top_products list.
  let topProducts = current.top_products;

  // Overrides aggregate()'s code-only, returns-less by_country with the
  // ShopifyQL-sourced breakdown — see the Promise.all comment above.
  let byCountry = currentCountry.map((c) => ({
    country: c.country,
    orders: c.orders,
    gross_sales: c.gross_sales,
    net_sales: c.net_sales,
    aov: c.orders ? c.net_sales / c.orders : null,
    return_rate: c.gross_sales ? c.return_value / c.gross_sales : null,
  }));

  if (wantYoy) {
    const yoyAgg = applySalesReversals(applySalesSummary(aggregate(yoyOrders), yoySalesSummary), yoyReversals);
    const yoyCogsFinal = resolveCogs(site, yoyAgg.kpis.gross_sales, yoyCogs);
    result.yoy = {
      range: yoyRange,
      gross_sales_change: pctChange(current.kpis.gross_sales, yoyAgg.kpis.gross_sales),
      net_sales_change: pctChange(current.kpis.net_sales, yoyAgg.kpis.net_sales),
      orders_change: pctChange(current.kpis.orders, yoyAgg.kpis.orders),
      cogs_change: pctChange(current.kpis.cogs, yoyCogsFinal),
    };
    topProducts = attachChangeByKey(topProducts, yoyAgg.top_products, 'title', 'gross_sales_yoy_change');
    byCountry = attachChangeByKey(byCountry, yoyCountry, 'country', 'gross_sales_yoy_change');
  }

  if (wantMom) {
    const momAgg = applySalesReversals(applySalesSummary(aggregate(momOrders), momSalesSummary), momReversals);
    const momCogsFinal = resolveCogs(site, momAgg.kpis.gross_sales, momCogs);
    result.mom = {
      range: momRange,
      gross_sales_change: pctChange(current.kpis.gross_sales, momAgg.kpis.gross_sales),
      net_sales_change: pctChange(current.kpis.net_sales, momAgg.kpis.net_sales),
      orders_change: pctChange(current.kpis.orders, momAgg.kpis.orders),
      cogs_change: pctChange(current.kpis.cogs, momCogsFinal),
    };
    topProducts = attachChangeByKey(topProducts, momAgg.top_products, 'title', 'gross_sales_mom_change');
    byCountry = attachChangeByKey(byCountry, momCountry, 'country', 'gross_sales_mom_change');
  }

  result.top_products = topProducts;
  result.by_country = byCountry;
  // Tells the frontend which address ShopifyQL actually grouped by — the
  // shipping-country query can fall back to billing (see fetchCountryBreakdown
  // in src/shopify.js), and Tomer should see an honest label either way
  // instead of Section 5 silently mislabeling billing-address data as
  // shipping-address data.
  result.by_country_grouped_by = currentCountryResult.groupedBy;
  return result;
}

// Added 2026-08-24 per Tomer's request ("Top 15 selling products, the YOY
// and MOM does not pulling data" on the live Sync path); generalized the
// same day to also serve the Sales by Country YoY/MoM fix (was named
// attachProductChange, keyed only on `title` — renamed/parameterized rather
// than duplicated, since the country version is identical except for which
// field identifies a matching row). Matches each current-period row (product
// or country) to the SAME `key` value in a comparison period's list and
// computes a gross-sales % change, same formula as the store-wide
// pctChange() above. A row with no match in the comparison period (a
// brand-new product/a country with zero orders that period, or a renamed
// product) gets `null` for this field rather than a misleading number —
// matching is by exact string equality, there's no stable ID carried through
// aggregate() or fetchCountryBreakdown for either dimension.
function attachChangeByKey(currentRows, comparisonRows, key, field) {
  const comparisonByKey = new Map(
    (comparisonRows || []).map((r) => [r[key], r.gross_sales])
  );
  return currentRows.map((r) => ({
    ...r,
    [field]: pctChange(r.gross_sales, comparisonByKey.get(r[key])),
  }));
}

// Overrides an aggregate() result's gross_sales/discounts_total/orders with
// Shopify's own authoritative "FROM sales" ShopifyQL totals (see
// fetchSalesSummary in src/shopify.js for the full rationale — this replaces
// the earlier approach of reconstructing these 3 figures by including/
// excluding individual orders via search-query filters, which produced a
// wrong-direction fix twice in one day on 2026-08-25). net_sales is NOT
// pulled directly here — it's still derived downstream by
// applySalesReversals() from these corrected gross_sales/discounts_total
// values plus the separately-sourced sales_reversals figure, so there's
// exactly one source of truth per figure and the on-page arithmetic (Gross
// Sales - Discounts - Returns = Net Sales) can never disagree with itself.
//
// Section 6's per-tag discount breakdown and its Total row denominator
// (discounts_total_gross/discounts_total_abs, both read by the frontend) are
// rescaled against the new authoritative discounts_total so Section 1's
// Discounts tile and Section 6's own percentages stay consistent with each
// other — otherwise Section 6's tag rows (still built from aggregate()'s
// order-derived total) would sum to a slightly different total than what
// Section 1 now shows.
//
// Deliberately NOT touched here: top_products, by_country (already
// overridden separately by fetchCountryBreakdown), units_sold,
// units_returned — `FROM sales` has no per-order/per-product dimension to
// replace those with; they still come from the Orders API via aggregate().
function applySalesSummary(aggResult, summary) {
  const { kpis, discounts } = aggResult;
  const newDiscountsTotal = summary.discounts_total;
  const rescaledDiscounts = discounts.map((d) => ({
    ...d,
    pct_of_total_discounts: newDiscountsTotal ? d.discount_value / newDiscountsTotal : null,
  }));
  return {
    ...aggResult,
    kpis: {
      ...kpis,
      gross_sales: summary.gross_sales,
      discounts_total: newDiscountsTotal,
      orders: summary.orders,
    },
    discounts: rescaledDiscounts,
    discounts_total_gross: summary.gross_sales,
    discounts_total_abs: newDiscountsTotal,
    discounts_total_orders: summary.orders,
  };
}

// Overrides an aggregate() result's returns_total with Shopify's own
// sales_reversals figure (see fetchSalesReversals in src/shopify.js), and
// recomputes the two KPIs that are derived from it: net_sales and
// average_order_value. units_returned is left as aggregate() computed it
// (order-created-date based) — Tomer's request was specifically about the
// Returns dollar figure, and Shopify's ShopifyQL sales_reversals metric
// doesn't expose a units figure to replace it with.
function applySalesReversals(aggResult, salesReversals) {
  const { kpis } = aggResult;
  const netSales = kpis.gross_sales - kpis.discounts_total - salesReversals;
  const aov = kpis.orders ? netSales / kpis.orders : 0;
  return {
    ...aggResult,
    kpis: {
      ...kpis,
      returns_total: salesReversals,
      net_sales: netSales,
      average_order_value: aov,
    },
  };
}

// GET /api/data?site=com&start=2026-08-01&end=2026-08-21&compare=yoy,mom
app.get('/api/data', async (req, res) => {
  const compare = String(req.query.compare || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  try {
    const result = await buildDataResponse({ ...req.query, compare });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(err.status || 502).json({ error: err.message });
  }
});

// POST /api/sync — same thing, POST-shaped for the dashboard's "Sync" button
// (body: { site, start, end, compare: ["yoy","mom"] }).
app.post('/api/sync', async (req, res) => {
  const { site, start, end, compare = [] } = req.body || {};
  try {
    const result = await buildDataResponse({ site, start, end, compare });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(err.status || 502).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`ND dashboard backend listening on port ${PORT}`);
});
