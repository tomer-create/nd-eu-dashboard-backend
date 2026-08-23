require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { fetchOrders } = require('./src/shopify');
const { aggregate } = require('./src/aggregate');

const app = express();
const PORT = process.env.PORT || 3000;

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
