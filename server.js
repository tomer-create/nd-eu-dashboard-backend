require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { fetchOrders, getAuthorizeUrl, exchangeCodeForToken } = require('./src/shopify');
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
// Visit /auth/<site> once per store, approve the Shopify screen, and
// /auth/callback will show you a permanent access token to copy into
// Render as SHOPIFY_<SITE>_ACCESS_TOKEN. See README.md.
app.get('/auth/:site', (req, res) => {
  const { site } = req.params;
  if (!VALID_SITES.includes(site)) {
    return res.status(400).send(`Unknown site "${site}". Must be one of: ${VALID_SITES.join(', ')}`);
  }
  const redirectUri = `${req.protocol}://${req.get('host')}/auth/callback`;
  try {
    res.redirect(getAuthorizeUrl(site, redirectUri));
  } catch (err) {
    res.status(500).send(err.message);
  }
});

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

  const orders = await fetchOrders(site, start, end);
  const current = aggregate(orders);
  const result = { site, start, end, ...current };

  if (compare.includes('yoy')) {
    const range = shiftDateRange(start, end, { years: 1 });
    const yoyOrders = await fetchOrders(site, range.start, range.end);
    const yoyAgg = aggregate(yoyOrders);
    result.yoy = {
      range,
      gross_sales_change: pctChange(current.kpis.gross_sales, yoyAgg.kpis.gross_sales),
      net_sales_change: pctChange(current.kpis.net_sales, yoyAgg.kpis.net_sales),
      orders_change: pctChange(current.kpis.orders, yoyAgg.kpis.orders),
    };
  }

  if (compare.includes('mom')) {
    const range = shiftDateRange(start, end, { months: 1 });
    const momOrders = await fetchOrders(site, range.start, range.end);
    const momAgg = aggregate(momOrders);
    result.mom = {
      range,
      gross_sales_change: pctChange(current.kpis.gross_sales, momAgg.kpis.gross_sales),
      net_sales_change: pctChange(current.kpis.net_sales, momAgg.kpis.net_sales),
      orders_change: pctChange(current.kpis.orders, momAgg.kpis.orders),
    };
  }

  return result;
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
