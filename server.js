require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const { fetchOrders, fetchOrdersLight, fetchOrdersForTierRevenue, fetchSalesReversals, fetchCostOfGoodsSold, fetchTopReturnsByProduct, fetchCountryBreakdown, fetchSalesSummary, fetchCustomerAcquisition, fetchProductRetailPrices, getAuthorizeUrl, exchangeCodeForToken } = require('./src/shopify');
const { aggregate } = require('./src/aggregate');
const { fetchChannelPerformance } = require('./src/triplewhale');
const { fetchPnlSheetChannels, fetchPnlSheetOtherCosts } = require('./src/googlesheets');
const { VALID_SITES: YOTPO_VALID_SITES, ensureYotpoSchema, recordYotpoEvent, getYotpoSummary, getYotpoCustomerTierMap, getPool: getYotpoPool } = require('./src/yotpo');
const { registerYotpoWebhooksForSite } = require('./src/yotpo-setup');
const { importYotpoHistory } = require('./src/yotpo-import');
const multer = require('multer');
const yotpoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const app = express();
const PORT = process.env.PORT || 3000;

// Section 8 (Yotpo Loyalty) — added 2026-09-06. Runs once at boot; harmless
// no-op if DATABASE_URL isn't configured yet (ensureYotpoSchema/getPool
// both degrade gracefully — see src/yotpo.js's file header for the full
// architecture rationale, including why this needs its own database at
// all instead of a live query like every other section).
ensureYotpoSchema().then((ok) => {
  if (ok) console.log('yotpo: schema ready');
  else console.log('yotpo: DATABASE_URL not configured yet — Section 8 will report no_data until it is');
});

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

// Serves the dashboard itself (public/index.html + any assets alongside it)
// from this same service — added 2026-08-31 after discovering that pages
// published via Claude's Artifact tool run in a sandbox that silently
// blocks fetch() to any external domain, which is why the Sync button
// always failed with "Failed to fetch" on the claude.ai artifact link (for
// every section, not just the new Triple Whale one — see
// dashboard-build-notes.md for the full investigation). Serving the
// dashboard HTML from this same Render service puts the page and the API on
// the same origin, so Sync's fetch calls are no longer cross-origin at all
// and the sandbox restriction doesn't apply. Visit this service's own URL
// directly (e.g. https://nd-dashboard-backend.onrender.com/) to use the
// live, Sync-capable dashboard — the claude.ai artifact link can stay
// around as a snapshot-only preview, but Sync will never work there.
// express.static serves public/index.html automatically for GET /.
app.use(express.static(path.join(__dirname, 'public')));

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

// Per-site "retail-price COGS" override — added 2026-08-25 per Tomer's
// request, refined over three rounds: (1) "COGS should be calculated as 30%
// out of the gross sales" — implemented as a straight 30% x gross_sales
// override; (2) clarified that "retail price" means something OTHER than
// gross_sales (which is already product price x quantity BEFORE discounts —
// see fetchSalesSummary's comment in src/shopify.js — so a plain rename
// wouldn't have changed anything); (3) clarified that the retail/list price
// should come directly from Shopify's own product catalog, not a manually
// maintained price list. See fetchProductRetailPrices in src/shopify.js for
// the catalog-price fetch and its "current snapshot, not historical price"
// caveat. ND.IL's live ShopifyQL cost_of_goods_sold pull relies on each
// product variant having a "cost per item" set in Shopify admin (see the
// note on fetchCostOfGoodsSold in src/shopify.js) — Tomer's request implies
// that isn't reliably populated for this store, so this fixed-percentage-of-
// retail-value estimate stands in instead. Keyed by site so another store
// could get the same treatment later without touching the call sites below —
// sites not listed here are unaffected and keep using the live ShopifyQL
// cost_of_goods_sold figure.
const RETAIL_COGS_SITES = { il: 0.3 };

// Estimates a period's implied retail value as SUM(units_sold x current
// catalog price) across every product sold that period, then returns `pct`
// of that as COGS. `topProducts` is an aggregate()-shaped array (from either
// the current period or a YoY/MoM comparison period — see the 3 call sites
// below), each row already carrying `units_sold`/`gross_sales`/`title`.
// `retailPriceByTitle` is the Map returned by fetchProductRetailPrices,
// keyed by exact product title (same title-only matching this codebase uses
// everywhere else — see the comment on fetchProductRetailPrices).
//
// FALLBACK: a product sold in the period but missing from the current
// catalog price lookup (discontinued/renamed since, or a title mismatch)
// falls back to that product's own gross_sales for this estimate, rather
// than being silently dropped from the COGS total — flagged to Tomer when
// this was proposed, no objection raised, so this is the standing default.
function computeCogsFromRetailPrices(topProducts, retailPriceByTitle, pct) {
  let retailValue = 0;
  for (const p of topProducts || []) {
    const price = retailPriceByTitle.get(p.title);
    retailValue += price != null ? price * (p.units_sold || 0) : (p.gross_sales || 0);
  }
  return retailValue * pct;
}

// Resolves the COGS figure to report for a period: the retail-price-based
// estimate above for sites in RETAIL_COGS_SITES (when the catalog price
// lookup succeeded), or the live ShopifyQL cost_of_goods_sold pull for every
// other site — unchanged from before this feature existed.
function resolveCogs(site, topProducts, retailPrices, shopifyCogs) {
  const pct = RETAIL_COGS_SITES[site];
  if (pct != null && retailPrices) return computeCogsFromRetailPrices(topProducts, retailPrices, pct);
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
  // retailPrices (added 2026-08-25, call 18) fetches the current Shopify
  // catalog price for every product — see fetchProductRetailPrices in
  // src/shopify.js and RETAIL_COGS_SITES above. Only fetched for sites that
  // actually use the retail-price COGS override (currently just ND.IL) —
  // skipped entirely for every other site so this doesn't add latency to
  // ND.COM/ND.EU syncs. Unlike the other calls above, this ISN'T
  // date-range-scoped (it's a catalog snapshot) — fetched once and reused for
  // the current/YoY/MoM periods below rather than 3 times.
  //
  // channelPerformance (added 2026-08-31, call 19) pulls Section 4's live
  // spend/CV-per-channel figures from Triple Whale — see src/triplewhale.js
  // for the full data-model rationale (why "Last Click" order_revenue is
  // "Pixel CV" and channel_reported_conversion_value is "Channel CV", and
  // which of the 9 requested channels get which). Only for the CURRENT
  // period — Section 4 doesn't have a YoY/MoM comparison view, so there's no
  // equivalent of the yoy/mom Shopify calls above. Wrapped so a Triple Whale
  // outage or a not-yet-configured TRIPLEWHALE_API_KEY can never fail the
  // rest of the sync (see fetchChannelPerformance's own try/catch too — this
  // is a second, redundant safety net since it runs inside the same
  // Promise.all as calls that ARE allowed to throw).
  //
  // pnlSheetChannels (added 2026-09-03, call 20) covers the Section 4
  // channels Triple Whale genuinely can't: Attentive's 4 channels,
  // Microsoft Ads, Pinterest, Organic, and TikTok Affiliates + Organic —
  // read live from the same "Marketing P&L 2026" Google Sheet the monthly
  // P&L-update skill maintains, via the sheet's public CSV export (Tomer
  // chose this 2026-09-03 over a Google Cloud service account specifically
  // to avoid that setup — see src/googlesheets.js for the full rationale,
  // the sheet's row/column layout, and the one-time "Anyone with the link"
  // sharing change needed for this to return anything other than null,
  // rather than a Google Cloud service account). Also wrapped in its own
  // try/catch for the same reason
  // as channelPerformance above — a Sheets hiccup must never fail the rest
  // of the sync.
  //
  // pnlSheetOtherCosts (added 2026-09-03, call 21) covers Section 7 (Other
  // Costs) — Tomer: "fix the Profit and the profit margin... should be
  // formula: net sales - Other Costs. also the other costs section doesn't
  // pull from the spreadsheet." Unlike pnlSheetChannels above, this covers
  // ALL 3 sites (each with its own curated line-item list — see
  // OTHER_COST_ROWS in src/googlesheets.js), because Profit/Profit Margin
  // need it to be live for all 3 sites too. Same public-CSV-export
  // approach, same independent try/catch — a Sheets hiccup here must never
  // fail the rest of the sync, and must never take down Section 4's own
  // pnlSheetChannels call either (they're independent try/catches on
  // independent calls).
  //
  // All 21 calls run in one Promise.all so none of this adds extra
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
    currentAcquisition,
    yoyAcquisition,
    momAcquisition,
    retailPrices,
    channelPerformance,
    pnlSheetChannels,
    pnlSheetOtherCosts,
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
    // New vs. returning customers (added 2026-09-06) — see
    // fetchCustomerAcquisition in src/shopify.js for why this is a plain
    // ShopifyQL aggregate call (same cheap shape as salesSummary/reversals/
    // COGS above) needing no new OAuth scope, unlike the Net Sales-by-tier
    // feature's Shopify order fetch.
    fetchCustomerAcquisition(site, start, end),
    wantYoy ? fetchCustomerAcquisition(site, yoyRange.start, yoyRange.end) : Promise.resolve(null),
    wantMom ? fetchCustomerAcquisition(site, momRange.start, momRange.end) : Promise.resolve(null),
    RETAIL_COGS_SITES[site] != null ? fetchProductRetailPrices(site) : Promise.resolve(null),
    fetchChannelPerformance(site, start, end).catch((err) => {
      console.error(`fetchChannelPerformance threw for site=${site}:`, err.message);
      return null;
    }),
    fetchPnlSheetChannels(site, start).catch((err) => {
      console.error(`fetchPnlSheetChannels threw for site=${site}:`, err.message);
      return null;
    }),
    fetchPnlSheetOtherCosts(site, start).catch((err) => {
      console.error(`fetchPnlSheetOtherCosts threw for site=${site}:`, err.message);
      return null;
    }),
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
  current.kpis.cogs = resolveCogs(site, current.top_products, retailPrices, currentCogs);
  // New vs. returning customers (added 2026-09-06) — see fetchCustomerAcquisition
  // in src/shopify.js. Attached the same way COGS is above: a plain field on
  // kpis, read by the frontend's LIVE_KPI_MAP ('New Users'/'Returning Users').
  current.kpis.new_customers = currentAcquisition.new_customers;
  current.kpis.returning_customers = currentAcquisition.returning_customers;
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
    const yoyCogsFinal = resolveCogs(site, yoyAgg.top_products, retailPrices, yoyCogs);
    result.yoy = {
      range: yoyRange,
      gross_sales_change: pctChange(current.kpis.gross_sales, yoyAgg.kpis.gross_sales),
      net_sales_change: pctChange(current.kpis.net_sales, yoyAgg.kpis.net_sales),
      orders_change: pctChange(current.kpis.orders, yoyAgg.kpis.orders),
      cogs_change: pctChange(current.kpis.cogs, yoyCogsFinal),
      new_customers_change: pctChange(current.kpis.new_customers, yoyAcquisition.new_customers),
      returning_customers_change: pctChange(current.kpis.returning_customers, yoyAcquisition.returning_customers),
    };
    topProducts = attachChangeByKey(topProducts, yoyAgg.top_products, 'title', 'gross_sales_yoy_change');
    byCountry = attachChangeByKey(byCountry, yoyCountry, 'country', 'gross_sales_yoy_change');
  }

  if (wantMom) {
    const momAgg = applySalesReversals(applySalesSummary(aggregate(momOrders), momSalesSummary), momReversals);
    const momCogsFinal = resolveCogs(site, momAgg.top_products, retailPrices, momCogs);
    result.mom = {
      range: momRange,
      gross_sales_change: pctChange(current.kpis.gross_sales, momAgg.kpis.gross_sales),
      net_sales_change: pctChange(current.kpis.net_sales, momAgg.kpis.net_sales),
      orders_change: pctChange(current.kpis.orders, momAgg.kpis.orders),
      cogs_change: pctChange(current.kpis.cogs, momCogsFinal),
      new_customers_change: pctChange(current.kpis.new_customers, momAcquisition.new_customers),
      returning_customers_change: pctChange(current.kpis.returning_customers, momAcquisition.returning_customers),
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

  // Section 4 (Marketing & Sales Channel Performance) live sync — Triple
  // Whale (added 2026-08-31) plus the P&L Google Sheet (added 2026-09-03,
  // see src/googlesheets.js) as a fallback for the channels Triple Whale
  // can't cover at all. `channelPerformance`/`pnlSheetChannels` are each
  // independently null when their credentials aren't configured yet, the
  // relevant source has nothing for this range, or the request failed
  // (already logged above) — mergeChannelSources handles any combination of
  // both being present, either, or neither. When both end up null we omit
  // `channels` entirely and the frontend keeps showing the existing
  // P&L-sheet snapshot for Section 4, same as before either feature
  // existed.
  const mergedChannels = mergeChannelSources(channelPerformance, pnlSheetChannels);
  if (mergedChannels) {
    result.channels = mergedChannels;
  }

  // Section 7 (Other Costs) live sync — P&L Google Sheet (added 2026-09-03,
  // see fetchPnlSheetOtherCosts in src/googlesheets.js), all 3 sites. Unlike
  // Section 4 above there's only one source here, so no merge step — just
  // attach it when the sheet actually returned something (null when the
  // sheet fetch failed or the site/month wasn't found; already logged in
  // googlesheets.js). The frontend (mergeLiveIntoMonthData in
  // dashboard_v2.html) is responsible for overriding the "Product Cost"
  // line with the live Shopify COGS figure (see the COGS KPI added
  // 2026-08-24) rather than trusting the sheet for that one line, and for
  // recomputing the Profit/Profit Margin KPIs from Net Sales and this
  // total — none of that happens here, this endpoint just hands over the
  // raw sheet-sourced line items.
  if (pnlSheetOtherCosts) {
    result.other_costs = pnlSheetOtherCosts;
  }

  return result;
}

// Combines Section 4 channel data from Triple Whale and the P&L Google
// Sheet into one array, keyed by the dashboard-facing `label` both sources
// already use (see CHANNEL_MAP in src/triplewhale.js and CHANNEL_ROWS in
// src/googlesheets.js). Triple Whale wins whenever it actually has data for
// a label — it's live for any date range, while the sheet is only as fresh
// as the last manual/skill update — the sheet only fills in a label Triple
// Whale left as `no_data: true` or never mentioned at all. Returns null
// only when there's truly nothing from either source, so callers can keep
// their existing "omit `channels` if falsy" behavior unchanged.
function mergeChannelSources(twChannels, sheetChannels) {
  if (!twChannels && !sheetChannels) return null;
  const byLabel = new Map();
  (twChannels || []).forEach((c) => byLabel.set(c.label, c));
  (sheetChannels || []).forEach((c) => {
    const existing = byLabel.get(c.label);
    if (!existing || existing.no_data) byLabel.set(c.label, c);
  });
  const merged = Array.from(byLabel.values());
  return merged.length ? merged : null;
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

// --- Section 8 (Yotpo Loyalty) — added 2026-09-06 ---
//
// See src/yotpo.js's file header for the full architecture rationale.
// Short version: Yotpo has no bulk reporting API, so instead Yotpo pushes
// us webhook events in real time and we accumulate them in our own
// Postgres database — these 2 routes are the receiving end (Yotpo calling
// us) and the reading end (the dashboard calling us), same request/response
// shape conventions as every other route in this file.
//
// POST /api/yotpo/webhook/:site?token=<YOTPO_WEBHOOK_SECRET>
//
// The `token` query param is NOT part of Yotpo's own auth — it's a shared
// secret WE chose (set as YOTPO_WEBHOOK_SECRET in Render's env vars) and
// baked into the callback URL when the webhook target is registered (see
// scripts/register-yotpo-webhooks.js), so a stranger who finds this URL
// can't feed garbage into the database. Always return 200 quickly (Yotpo
// will retry/disable a target that errors or times out repeatedly) even
// when the event couldn't be fully parsed — recordYotpoEvent() itself
// already never throws for a recognition miss, only for a genuine
// infrastructure problem (e.g. the database being unreachable), which is
// the one case worth surfacing as a real error.
app.post('/api/yotpo/webhook/:site', async (req, res) => {
  const site = req.params.site;
  if (!YOTPO_VALID_SITES.includes(site)) {
    return res.status(404).json({ error: `Unknown site "${site}"` });
  }
  const expected = process.env.YOTPO_WEBHOOK_SECRET;
  if (expected && req.query.token !== expected) {
    return res.status(403).json({ error: 'Invalid or missing token' });
  }
  try {
    const topic = req.body && req.body.topic;
    await recordYotpoEvent(site, topic, req.body || {});
    res.json({ ok: true });
  } catch (err) {
    console.error(`yotpo webhook (site=${site}) failed:`, err.message);
    // Still 200 — an infra hiccup on our end shouldn't make Yotpo think
    // this endpoint is broken and back off retries/disable the target;
    // the error is logged for us to catch, the event is just not saved
    // this one time.
    res.status(200).json({ ok: false, error: err.message });
  }
});

// Joins Shopify order revenue against Yotpo tier membership for Section 8's
// Net Sales-by-tier column — added 2026-09-06 per Tomer ("add to the Yotpo
// Loyalty another column with the Revenue of the tier on Net sales").
//
// Deliberately NOT folded into getYotpoSummary (src/yotpo.js) — that
// function is a pure DB read with no Shopify dependency, and this needs a
// live Shopify order fetch (fetchOrdersForTierRevenue), which is real extra
// API cost per call. Gated behind the `include_revenue` query param below so
// the YoY/MoM fetches the frontend already makes for this same endpoint
// (see fetchYotpoSummaryForSite in public/index.html) don't ALSO pay for a
// Shopify order fetch every time — only the current-period fetch requests
// it, since Tomer only asked for one column, not YoY/MoM on it too.
//
// Only counts orders whose customer email matches a KNOWN yotpo_customers
// row for this site (see getYotpoCustomerTierMap's own comment for why a
// non-member order must be excluded entirely rather than folded into
// BRONZE). Net Sales per order = sum(lineItems.originalTotalSet) -
// totalDiscountsSet — the exact same definition src/aggregate.js uses
// store-wide, just computed per order here so it can be split by tier.
async function computeYotpoTierRevenue(site, start, end) {
  const [orders, tierByEmail] = await Promise.all([
    fetchOrdersForTierRevenue(site, start, end),
    getYotpoCustomerTierMap(site),
  ]);

  const revenueByTier = new Map();
  for (const order of orders) {
    const email = order.customer && order.customer.email ? order.customer.email.toLowerCase() : null;
    if (!email) continue; // guest checkout / no email on the order at all
    const tier = tierByEmail.get(email);
    if (!tier) continue; // not a known Yotpo member — excluded, not folded into BRONZE

    const gross = order.lineItems.edges.reduce(
      (sum, e) => sum + Number((e.node.originalTotalSet && e.node.originalTotalSet.shopMoney && e.node.originalTotalSet.shopMoney.amount) || 0),
      0
    );
    const discount = Number((order.totalDiscountsSet && order.totalDiscountsSet.shopMoney && order.totalDiscountsSet.shopMoney.amount) || 0);
    const netSales = gross - discount;

    revenueByTier.set(tier, (revenueByTier.get(tier) || 0) + netSales);
  }
  return revenueByTier;
}

// GET /api/yotpo/summary?site=com&start=2026-09-01&end=2026-09-06[&include_revenue=1]
app.get('/api/yotpo/summary', async (req, res) => {
  const { site, start, end, include_revenue } = req.query;
  if (!YOTPO_VALID_SITES.includes(site)) {
    return res.status(400).json({ error: `Unknown or missing site "${site}"` });
  }
  try {
    const summary = await getYotpoSummary(site, start, end);
    if (!summary) return res.json({ site, start, end, no_data: true });

    if (include_revenue === '1' && !summary.no_data) {
      try {
        const revenueByTier = await computeYotpoTierRevenue(site, start, end);
        const seenTiers = new Set();
        summary.redemptions_by_tier = summary.redemptions_by_tier.map((r) => {
          seenTiers.add(r.tier);
          return { ...r, net_sales: revenueByTier.get(r.tier) || 0 };
        });
        // A tier can have Net Sales this period with zero redemptions (a
        // member who bought something but didn't redeem points) — don't let
        // that revenue silently vanish just because it has no row yet.
        for (const [tier, netSales] of revenueByTier.entries()) {
          if (!seenTiers.has(tier)) {
            summary.redemptions_by_tier.push({ tier, redemptions: 0, points_used: 0, points_value: 0, net_sales: netSales });
          }
        }
        summary.revenue_included = true;
      } catch (err) {
        // Most likely cause right now: the store's Shopify access token
        // predates the read_customers scope (added 2026-09-06 alongside
        // this feature) and needs re-authorizing — see src/shopify.js's
        // SCOPES comment. Degrade gracefully: the rest of Section 8 (which
        // has nothing to do with Shopify) still renders normally, just
        // without net_sales on each row.
        console.error(`yotpo tier revenue (site=${site}) failed:`, err.message);
        summary.revenue_error = err.message;
      }
    }

    res.json(summary);
  } catch (err) {
    console.error(err);
    res.status(err.status || 502).json({ error: err.message });
  }
});

// GET /admin/yotpo/inspect?site=com&start=2025-01-01&end=2025-02-01&token=<ADMIN_SETUP_TOKEN>[&event_type=redemption][&sample=3]
//
// Temporary diagnostic endpoint — added 2026-09-06 to investigate why
// ND.COM's BACKFILLED (historical CSV import) redemption events show ~0%
// Glow/Glam for all of 2025 despite the loyalty program running since 2023
// (Tomer confirmed 2026-09-06 this isn't organic growth — the low/zero
// Glow/Glam count for 2025 is unexpected). Live/webhook data since ~Sept
// 2026 correctly shows a real Bronze/Glow/Glam mix, so this is specific to
// the historical import's tier approximation (see parseRedemptionsCsv /
// importYotpoHistory in src/yotpo-import.js — backfilled redemptions are
// tagged with each customer's CURRENT tier as of the Customers CSV export,
// not their tier at the time of the historical redemption).
//
// Read-only, doesn't touch or fix any data. Returns the DISTINCT raw
// tier_at_event values actually stored for the requested window (with
// counts) plus a few raw_payload samples per distinct value — the
// raw_payload is the exact original CSV row for a backfilled event, so this
// shows precisely what the historical export recorded (a real tier name, an
// unrecognized raw ID, blank/null, etc.) without needing direct Postgres
// access. Safe to delete once the mismatch is diagnosed.
app.get('/admin/yotpo/inspect', async (req, res) => {
  const token = req.query.token;
  const adminToken = process.env.ADMIN_SETUP_TOKEN;
  if (!adminToken || token !== adminToken) {
    return res.status(403).send('Invalid or missing token.');
  }
  const { site, start, end } = req.query;
  const eventType = req.query.event_type || 'redemption';
  const sampleSize = Math.min(Number(req.query.sample) || 3, 10);
  if (!YOTPO_VALID_SITES.includes(site)) {
    return res.status(400).json({ error: `Unknown or missing site "${site}"` });
  }
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end query params are required (YYYY-MM-DD)' });
  }
  const pool = getYotpoPool();
  if (!pool) return res.status(503).json({ error: 'DATABASE_URL not configured' });
  try {
    const distinctRes = await pool.query(
      `SELECT tier_at_event, COUNT(*) AS n
       FROM yotpo_events
       WHERE site = $1 AND event_type = $2 AND received_at >= $3 AND received_at < $4
       GROUP BY tier_at_event
       ORDER BY n DESC`,
      [site, eventType, start, end]
    );
    const tiers = distinctRes.rows.map((r) => ({ tier_at_event: r.tier_at_event, count: Number(r.n) }));

    // One small sample per distinct value, including raw_payload (the
    // original CSV row for a backfilled event, or the original webhook body
    // for a live event) — this is what actually pins down the root cause.
    const samples = {};
    for (const t of tiers) {
      const sampleRes = await pool.query(
        `SELECT email, tier_at_event, points, received_at, topic, raw_payload
         FROM yotpo_events
         WHERE site = $1 AND event_type = $2 AND received_at >= $3 AND received_at < $4
           AND tier_at_event IS NOT DISTINCT FROM $5
         ORDER BY received_at ASC
         LIMIT $6`,
        [site, eventType, start, end, t.tier_at_event, sampleSize]
      );
      samples[t.tier_at_event === null ? '__NULL__' : t.tier_at_event] = sampleRes.rows;
    }

    // Optional: also look up specific email(s) directly in yotpo_customers —
    // added alongside this endpoint to answer the exact next question once
    // tier_at_event=null turned out to be the whole story: is the customer
    // simply ABSENT from yotpo_customers (never matched during the Customers
    // CSV import at all — tierByEmail.get() returns undefined), or present
    // with a null/blank current_tier (matched, but the CSV's own tier column
    // was empty for them)? Those are different root causes needing different
    // fixes. Comma-separated, case-insensitively matched (same normalization
    // importYotpoHistory uses: email.toLowerCase().trim()).
    let customerLookup = null;
    if (req.query.lookup_email) {
      const emails = String(req.query.lookup_email)
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);
      const lookupRes = await pool.query(
        `SELECT email, current_tier, first_seen_at, updated_at
         FROM yotpo_customers
         WHERE site = $1 AND email = ANY($2::text[])`,
        [site, emails]
      );
      const foundByEmail = new Map(lookupRes.rows.map((r) => [r.email, r]));
      customerLookup = emails.map((e) => foundByEmail.get(e) || { email: e, found: false });
    }

    // Aggregate-only match-rate check — added so this can be checked WITHOUT
    // ever putting a real customer email in a URL (lookup_email above is
    // left in for Tomer's own direct browser use, but shouldn't be
    // constructed by the assistant itself — no personal data in URL query
    // strings). Answers the exact open question from the null-tier finding:
    // of the distinct emails behind this window's events, how many have ANY
    // row at all in yotpo_customers (regardless of that row's current_tier
    // value)? A low/zero match rate means these customers were never
    // matched during the Customers CSV import (a join miss); a high match
    // rate with tier_at_event still null would instead mean they ARE in
    // yotpo_customers but with a blank/null current_tier — a different root
    // cause (the CSV's own tier column was empty for them).
    const matchRes = await pool.query(
      `SELECT
         COUNT(DISTINCT e.email) AS distinct_emails,
         COUNT(DISTINCT e.email) FILTER (WHERE c.email IS NOT NULL) AS matched_in_yotpo_customers,
         COUNT(DISTINCT e.email) FILTER (WHERE c.email IS NOT NULL AND c.current_tier IS NOT NULL) AS matched_with_nonnull_tier
       FROM yotpo_events e
       LEFT JOIN yotpo_customers c ON c.site = e.site AND c.email = e.email
       WHERE e.site = $1 AND e.event_type = $2 AND e.received_at >= $3 AND e.received_at < $4 AND e.email IS NOT NULL`,
      [site, eventType, start, end]
    );
    const matchRow = matchRes.rows[0];
    const customerMatchRate = {
      distinct_emails: Number(matchRow.distinct_emails),
      matched_in_yotpo_customers: Number(matchRow.matched_in_yotpo_customers),
      matched_with_nonnull_tier: Number(matchRow.matched_with_nonnull_tier),
    };

    res.json({ site, start, end, event_type: eventType, distinct_tier_at_event_values: tiers, samples, customer_lookup: customerLookup, customer_match_rate: customerMatchRate });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/yotpo/register-webhooks?site=com&token=<ADMIN_SETUP_TOKEN>
//
// One-time-per-site setup — visit this URL once in a browser (same
// convention as the existing /auth/:route Shopify setup flow above) after
// YOTPO_STORE_ID_<SITE>/YOTPO_SECRET_<SITE>/YOTPO_WEBHOOK_SECRET are set in
// Render. `token` here must match ADMIN_SETUP_TOKEN (a separate secret you
// choose) — this route can create real subscriptions on your live Yotpo
// account, so it's gated the same way the webhook receiver above is,
// just with its own token rather than reusing YOTPO_WEBHOOK_SECRET.
// Re-running it for a site that's already registered will surface Yotpo's
// own 409 "already exists" error, which is expected and harmless — see
// src/yotpo-setup.js's file header for the full picture, including why
// this step specifically is the most likely one to need a manual tweak.
app.get('/admin/yotpo/register-webhooks', async (req, res) => {
  const { site } = req.query;
  const adminToken = process.env.ADMIN_SETUP_TOKEN;
  if (!adminToken || req.query.token !== adminToken) {
    return res.status(403).json({ error: 'Invalid or missing token' });
  }
  if (!YOTPO_VALID_SITES.includes(site)) {
    return res.status(400).json({ error: `Unknown or missing site "${site}"` });
  }
  const upper = site.toUpperCase();
  const base = process.env.BACKEND_PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const callbackUrl = `${base}/api/yotpo/webhook/${site}?token=${encodeURIComponent(process.env.YOTPO_WEBHOOK_SECRET || '')}`;
  try {
    const result = await registerYotpoWebhooksForSite(site, {
      storeId: process.env[`YOTPO_STORE_ID_${upper}`],
      secret: process.env[`YOTPO_SECRET_${upper}`],
      callbackUrl,
    });
    res.json({ ok: true, site, ...result });
  } catch (err) {
    console.error(`yotpo webhook registration (site=${site}) failed:`, err.message);
    res.status(err.status || 502).json({ ok: false, error: err.message, body: err.body });
  }
});

// GET /admin/yotpo/import?site=com&token=<ADMIN_SETUP_TOKEN>
// POST /admin/yotpo/import?token=<ADMIN_SETUP_TOKEN>  (multipart: site, customers_csv, redemptions_csv)
//
// One-time-per-site historical backfill for Section 8 — added 2026-09-06.
// See src/yotpo-import.js's file header for the full picture: what can and
// can't be backfilled, the tier-approximation decision, and why re-running
// this is safe (it replaces the prior backfill for the site, never
// duplicates). This exists because Yotpo's webhooks only cover events from
// whenever registration went live — everything before that has to come
// from Yotpo's own manual CSV exports (Loyalty & Referrals admin →
// Analytics → Reports → Customers / Redemptions History), which Tomer
// downloads there and uploads here. Gated by the same ADMIN_SETUP_TOKEN as
// the webhook-registration route above, since this writes real historical
// data into the database.
app.get('/admin/yotpo/import', (req, res) => {
  const { site, token } = req.query;
  const adminToken = process.env.ADMIN_SETUP_TOKEN;
  if (!adminToken || token !== adminToken) {
    return res.status(403).send('Invalid or missing token.');
  }
  if (!YOTPO_VALID_SITES.includes(site)) {
    return res
      .status(400)
      .send(`Unknown or missing site "${site}" — use ?site=com, ?site=eu, or ?site=il.`);
  }
  res.send(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Yotpo history import — ${site}</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 20px; color: #222; }
  h1 { font-size: 20px; }
  label { display: block; margin: 18px 0 6px; font-weight: 600; }
  input[type=file] { display: block; }
  button { margin-top: 24px; padding: 10px 20px; font-size: 15px; cursor: pointer; }
  p.note { color: #555; font-size: 14px; }
</style>
</head>
<body>
  <h1>Import historical Yotpo Loyalty data — site: ${site}</h1>
  <p class="note">Export these two reports from Yotpo's Loyalty &amp; Referrals admin (Analytics → Reports) for the <strong>${site}</strong> account, then upload both CSV files here. New members and redemptions will be backfilled; tier movement can't be backfilled (Yotpo doesn't export tier-change history) — see the message on the result page for details.</p>
  <form method="POST" action="/admin/yotpo/import?token=${encodeURIComponent(token)}" enctype="multipart/form-data">
    <input type="hidden" name="site" value="${site}">
    <label for="customers_csv">Customers report (CSV)</label>
    <input type="file" id="customers_csv" name="customers_csv" accept=".csv" required>
    <label for="redemptions_csv">Redemptions History report (CSV)</label>
    <input type="file" id="redemptions_csv" name="redemptions_csv" accept=".csv" required>
    <button type="submit">Import</button>
  </form>
</body>
</html>`);
});

app.post('/admin/yotpo/import', yotpoUpload.fields([{ name: 'customers_csv', maxCount: 1 }, { name: 'redemptions_csv', maxCount: 1 }]), async (req, res) => {
  const adminToken = process.env.ADMIN_SETUP_TOKEN;
  if (!adminToken || req.query.token !== adminToken) {
    return res.status(403).send('Invalid or missing token.');
  }
  const site = req.body && req.body.site;
  if (!YOTPO_VALID_SITES.includes(site)) {
    return res.status(400).send(`Unknown or missing site "${site}".`);
  }
  const customersFile = req.files && req.files.customers_csv && req.files.customers_csv[0];
  const redemptionsFile = req.files && req.files.redemptions_csv && req.files.redemptions_csv[0];
  if (!customersFile || !redemptionsFile) {
    return res.status(400).send('Both the Customers CSV and Redemptions History CSV are required.');
  }
  const pool = getYotpoPool();
  if (!pool) {
    return res.status(503).send('DATABASE_URL is not configured yet — nothing to import into.');
  }
  try {
    await ensureYotpoSchema();
    const summary = await importYotpoHistory(pool, site, {
      customersBuffer: customersFile.buffer,
      redemptionsBuffer: redemptionsFile.buffer,
    });
    res.send(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Import complete — ${site}</title>
<style>body { font-family: -apple-system, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 20px; color: #222; } li { margin: 6px 0; } .warn { background: #fff8e1; border: 1px solid #f0d878; padding: 12px 16px; border-radius: 6px; margin-top: 20px; }</style>
</head>
<body>
  <h1>Import complete — ${site}</h1>
  <ul>
    <li>Customers with a known tier seeded: <strong>${summary.customers_seeded}</strong></li>
    <li>Historical new members imported: <strong>${summary.new_members_imported}</strong></li>
    <li>Historical redemptions imported: <strong>${summary.redemptions_imported}</strong></li>
    <li>Date range covered: <strong>${summary.earliest_date || 'n/a'}</strong> to <strong>${summary.latest_date || 'n/a'}</strong></li>
  </ul>
  <div class="warn">Redemptions above are grouped by each customer's <em>current</em> Yotpo tier (Yotpo doesn't export what tier they were on historically). Tier movement itself still can't be backfilled — Section 6 will only show real tier-change history from when the live webhook went live forward.</div>
  <p><a href="/admin/yotpo/import?site=${site}&token=${encodeURIComponent(req.query.token)}">Import again for ${site}</a> (replaces this import, doesn't duplicate) &nbsp;|&nbsp; <a href="/">Back to dashboard</a></p>
</body>
</html>`);
  } catch (err) {
    console.error(`yotpo history import (site=${site}) failed:`, err.message);
    res.status(500).send(`<pre>Import failed: ${String(err.message).replace(/</g, '&lt;')}</pre><p><a href="javascript:history.back()">Go back and try again</a></p>`);
  }
});

app.listen(PORT, () => {
  console.log(`ND dashboard backend listening on port ${PORT}`);
});
