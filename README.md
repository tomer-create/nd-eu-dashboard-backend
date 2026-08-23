# ND Sales Dashboard — backend

Small Express API that pulls live data straight from Shopify (via each
store's Dev Dashboard custom app) for the Natasha Denona Sales Dashboard's
"Sync" button and date-switcher.

It intentionally does **not** use ShopifyQL/`read_reports` (that requires
Shopify's "Level 2 protected customer data" approval). Instead it reads
orders directly (`read_orders` scope) and aggregates them in JavaScript.

## Endpoints

- `GET /health` — liveness check.
- `GET /api/data?site=com&start=2026-08-01&end=2026-08-21&compare=yoy,mom`
- `POST /api/sync` — body `{ "site": "com", "start": "...", "end": "...", "compare": ["yoy","mom"] }`

`site` is one of `com`, `eu`, `il`. Dates are `YYYY-MM-DD`, end-exclusive.

Response shape (per site/date range):

```json
{
  "site": "com",
  "start": "2026-08-01",
  "end": "2026-08-21",
  "kpis": { "gross_sales": 0, "net_sales": 0, "discounts_total": 0, "orders": 0, "average_order_value": 0, "units_sold": 0, "units_returned": 0, "returns_total": 0 },
  "top_products": [{ "title": "...", "units_sold": 0, "gross_sales": 0 }],
  "by_country": [{ "country": "US", "gross_sales": 0, "orders": 0 }],
  "discounts": [{ "tag": "...", "label": "...", "gross_sales": 0, "discount_value": 0, "discount_pct": 0, "orders": 0, "pct_of_total_discounts": 0 }],
  "discounts_total_gross": 0,
  "discounts_total_abs": 0,
  "discounts_total_orders": 0,
  "yoy": { "range": {...}, "gross_sales_change": 0.12, "net_sales_change": 0.08, "orders_change": 0.05 },
  "mom": { "range": {...}, "gross_sales_change": -0.3, "net_sales_change": -0.28, "orders_change": -0.2 }
}
```

**Known limitation:** "returns" only count refunds attached to orders
*created* inside the requested window — a refund issued this week against an
order from last month won't show up. Good enough for MTD trend tracking;
not an accounting-grade returns figure.

## One-time setup per store

For each of ND.COM / ND.EU / ND.IL you want live data for:

1. Go to [dev.shopify.com/dashboard](https://dev.shopify.com/dashboard) →
   Apps → Create app → "Start from Dev Dashboard" → name it (e.g.
   "ND Dashboard Sync — COM") → Create.
2. Versions tab → set an App URL placeholder, pick the newest Webhooks API
   version, and under Access scopes add: `read_orders`, `read_products`,
   `read_inventory` → Release.
3. Home → Install app → pick the matching store
   (`natashadenona.myshopify.com` / `natasha-denona-trading.myshopify.com` /
   `natashadenona-il.myshopify.com`) → Install.
4. Settings tab → copy the **Client ID** and **Client secret**.
5. In Render, open this service → **Environment** → add
   `SHOPIFY_<SITE>_CLIENT_ID` and `SHOPIFY_<SITE>_CLIENT_SECRET` (e.g.
   `SHOPIFY_COM_CLIENT_ID`) with those values, plus
   `SHOPIFY_<SITE>_DOMAIN` set to that store's `.myshopify.com` domain.

Do this directly in Render's dashboard — never paste Client ID/secret into
a chat. Tokens auto-refresh (client-credentials grant, ~24h expiry); nothing
else to maintain.

## Local development

```
npm install
cp .env.example .env   # fill in one store's values
npm start
curl "http://localhost:3000/api/data?site=com&start=2026-08-01&end=2026-08-21&compare=yoy,mom"
```
