require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { fetchOrders, fetchOrdersLight, fetchSalesReversals, getAuthorizeUrl, exchangeCodeForToken } = require('./src/shopify');
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
  // REFUND date instead. All 6 Shopify calls run in one Promise.all so this
  // doesn't add extra latency on top of the orders fetches.
  const [
    orders,
    yoyOrders,
    momOrders,
    currentReversals,
    yoyReversals,
    momReversals,
  ] = await Promise.all([
    fetchOrders(site, start, end),
    wantYoy ? fetchOrdersLight(site, yoyRange.start, yoyRange.end) : Promise.resolve(null),
    wantMom ? fetchOrdersLight(site, momRange.start, momRange.end) : Promise.resolve(null),
    fetchSalesReversals(site, start, end),
    wantYoy ? fetchSalesReversals(site, yoyRange.start, yoyRange.end) : Promise.resolve(null),
    wantMom ? fetchSalesReversals(site, momRange.start, momRange.end) : Promise.resolve(null),
  ]);

  const current = applySalesReversals(aggregate(orders), currentReversals);
  const result = { site, start, end, ...current };
  // Reassigned below as YoY/MoM per-product comparisons are computed —
  // starts as the current period's own top_products list.
  let topProducts = current.top_products;

  if (wantYoy) {
    const yoyAgg = applySalesReversals(aggregate(yoyOrders), yoyReversals);
    result.yoy = {
      range: yoyRange,
      gross_sales_change: pctChange(current.kpis.gross_sales, yoyAgg.kpis.gross_sales),
      net_sales_change: pctChange(current.kpis.net_sales, yoyAgg.kpis.net_sales),
      orders_change: pctChange(current.kpis.orders, yoyAgg.kpis.orders),
    };
    topProducts = attachProductChange(topProducts, yoyAgg.top_products, 'gross_sales_yoy_change');
  }

  if (wantMom) {
    const momAgg = applySalesReversals(aggregate(momOrders), momReversals);
    result.mom = {
      range: momRange,
      gross_sales_change: pctChange(current.kpis.gross_sales, momAgg.kpis.gross_sales),
      net_sales_change: pctChange(current.kpis.net_sales, momAgg.kpis.net_sales),
      orders_change: pctChange(current.kpis.orders, momAgg.kpis.orders),
    };
    topProducts = attachProductChange(topProducts, momAgg.top_products, 'gross_sales_mom_change');
  }

  result.top_products = topProducts;
  return result;
}

// Added 2026-08-24 per Tomer's request ("Top 15 selling products, the YOY
// and MOM does not pulling data" on the live Sync path). Matches each
// current-period product to the SAME product title in a comparison period's
// top_products list (from aggregate() — now available for yoy/mom too since
// ORDERS_QUERY_LIGHT fetches lineItems.title, see shopify.js) and computes a
// gross-sales % change, same formula as the store-wide pctChange() above. A
// product with no matching title in the comparison period (a brand-new
// launch, or a product renamed between the two periods — this matches by
// exact title string, there's no stable product ID carried through
// aggregate()) gets `null` for this field rather than a misleading number.
function attachProductChange(currentProducts, comparisonProducts, field) {
  const comparisonByTitle = new Map(
    (comparisonProducts || []).map((p) => [p.title, p.gross_sales])
  );
  return currentProducts.map((p) => ({
    ...p,
    [field]: pctChange(p.gross_sales, comparisonByTitle.get(p.title)),
  }));
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
