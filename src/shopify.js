// Shopify Admin API access via the standard Authorization Code Grant, plus
// a small GraphQL request helper with basic throttle-retry handling.
//
// Each store (com / eu / il) is configured through environment variables —
// see .env.example / README.md for the exact names.
//
// WHY NOT client_credentials? That grant is what the backend originally
// used, and it's documented by Shopify's own developer community as
// unreliable for paid/production stores: token issuance can succeed while
// the `orders` field itself still comes back ACCESS_DENIED, regardless of
// which scopes are configured on the app. This is a known rough edge in the
// still-new (as of 2026) Dev-Dashboard custom-app model. The Authorization
// Code Grant below is what Shopify's own docs recommend for backend/server
// apps, doesn't have that problem, and produces a token that never expires
// — so there's no 24h refresh logic to maintain either.
//
// One-time setup per store: visit GET /auth/<site> in a browser while
// logged into that store's Shopify admin, approve the scopes, and you'll
// land on /auth/callback showing a permanent access token. Copy that into
// Render as SHOPIFY_<SITE>_ACCESS_TOKEN. See README.md.

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';
// read_reports added 2026-08-24 for fetchSalesReversals() (shopifyqlQuery) —
// re-authorizing each store (visit /auth/<site> again) is required to mint a
// new token carrying this scope; the old tokens only have the first three.
// shopifyqlQuery also requires Shopify's separate Level 2 protected customer
// data approval on the app itself — see README.md.
const SCOPES = 'read_orders,read_products,read_inventory,read_reports';

function getSiteConfig(site) {
  const key = site.toUpperCase();
  const domain = process.env[`SHOPIFY_${key}_DOMAIN`];
  const clientId = process.env[`SHOPIFY_${key}_CLIENT_ID`];
  const clientSecret = process.env[`SHOPIFY_${key}_CLIENT_SECRET`];
  const accessToken = process.env[`SHOPIFY_${key}_ACCESS_TOKEN`];
  if (!domain || !clientId || !clientSecret) {
    throw new Error(
      `Missing Shopify app config for site "${site}". Expected env vars ` +
        `SHOPIFY_${key}_DOMAIN, SHOPIFY_${key}_CLIENT_ID, SHOPIFY_${key}_CLIENT_SECRET.`
    );
  }
  return { site, domain, clientId, clientSecret, accessToken };
}

// Builds the URL to send the merchant to for the one-time authorization.
function getAuthorizeUrl(site, redirectUri) {
  const { domain, clientId } = getSiteConfig(site);
  const url = new URL(`https://${domain}/admin/oauth/authorize`);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', site);
  return url.toString();
}

// Exchanges the one-time `code` from the callback for a permanent
// (non-expiring) offline access token.
async function exchangeCodeForToken(site, code) {
  const { domain, clientId, clientSecret } = getSiteConfig(site);
  const res = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Token exchange failed for "${site}" (${res.status}): ${text}`);
  }

  const data = await res.json();
  return data.access_token;
}

async function graphql(site, query, variables = {}, attempt = 0) {
  const { domain, accessToken } = getSiteConfig(site);

  if (!accessToken) {
    const key = site.toUpperCase();
    throw new Error(
      `No access token on file for site "${site}". Visit /auth/${site} once, approve the ` +
        `Shopify authorization screen, then add the resulting token to Render as ` +
        `SHOPIFY_${key}_ACCESS_TOKEN.`
    );
  }

  const res = await fetch(`https://${domain}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 429 && attempt < 5) {
    const retryAfter = Number(res.headers.get('Retry-After') || '1');
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return graphql(site, query, variables, attempt + 1);
  }

  const body = await res.json();

  if (body.errors) {
    const throttled = body.errors.some((e) => e.extensions?.code === 'THROTTLED');
    if (throttled && attempt < 5) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      return graphql(site, query, variables, attempt + 1);
    }
    throw new Error(`Shopify GraphQL error for "${site}": ${JSON.stringify(body.errors)}`);
  }

  return body.data;
}

const ORDERS_QUERY = `
  query OrdersForRange($cursor: String, $searchQuery: String!) {
    orders(first: 100, after: $cursor, query: $searchQuery, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          createdAt
          tags
          currentSubtotalPriceSet { shopMoney { amount } }
          subtotalPriceSet { shopMoney { amount } }
          totalDiscountsSet { shopMoney { amount } }
          shippingAddress { countryCode }
          lineItems(first: 100) {
            edges {
              node {
                title
                quantity
                originalTotalSet { shopMoney { amount } }
              }
            }
          }
          refunds {
            createdAt
            refundLineItems(first: 100) {
              edges {
                node {
                  quantity
                  subtotalSet { shopMoney { amount } }
                  lineItem { title }
                }
              }
            }
          }
        }
      }
    }
  }
`;

// Fetches every order created in [startISO, endISO) for a site, following
// pagination. startISO/endISO are plain 'YYYY-MM-DD' dates.
//
// -status:cancelled added 2026-08-24 after Tomer reported ND.EU's Gross
// Sales tile reading higher than Shopify's own Analytics home figure for the
// identical date range (dashboard sync: 633 orders / higher gross sales;
// Shopify's "Gross sales" panel for Aug 1-24, 2026: 623 orders / 71,583.46
// EUR). Root cause, confirmed by opening the actual orders: a handful of
// orders each period are Shopify order "swaps" created by a returns/exchange
// app (order notes carry `_swap-request-token`/`_swap-checkout-token`) that
// get immediately Voided or Refunded to a €0.00 net total. This backend's
// aggregate() (src/aggregate.js) sums each line item's `originalTotalSet` —
// the PRE-cancellation value — with no check on order.cancelledAt, so it
// kept counting a cancelled swap order's full original value (e.g. €130.68,
// €106.92 confirmed on two real orders) even though the order nets to zero.
// Shopify's own Analytics home "Gross sales" figure does not count these.
// Excluding `status:cancelled` orders at the search-query level (rather than
// fetching them and filtering client-side) matches Shopify's own number and
// is cheaper than pulling line items for orders we're going to discard
// anyway. This applies to both the current period and the YoY/MoM
// comparison periods (see fetchOrdersLight below) since both use the same
// aggregate() gross_sales calculation.
async function fetchOrders(site, startISO, endISO) {
  const searchQuery = `created_at:>=${startISO} created_at:<${endISO} -status:cancelled`;
  const orders = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await graphql(site, ORDERS_QUERY, { cursor, searchQuery });
    const { edges, pageInfo } = data.orders;
    for (const edge of edges) orders.push(edge.node);
    hasNextPage = pageInfo.hasNextPage;
    cursor = pageInfo.endCursor;
  }

  return orders;
}

// Slimmed-down version of ORDERS_QUERY for the YoY/MoM comparison periods.
// aggregate() in src/aggregate.js reads gross_sales/orders (via lineItems +
// totalDiscountsSet) AND per-product gross_sales (via lineItems.title) off
// the comparison periods' orders — by_country/discounts/units/returns are
// computed but discarded by buildDataResponse() for yoy/mom (returns come
// from fetchSalesReversals below, for all 3 periods, not from this query),
// so there's no reason to pay for refunds/refundLineItems/shippingAddress/
// tags on those two fetches. Each of those adds real GraphQL query cost per
// order, and doing all 3 periods (current + yoy + mom) concurrently means
// they compete for the same per-shop rate-limit budget — the lighter this
// query, the less that concurrency causes THROTTLED retries. `title` was
// added 2026-08-24 to support real per-product YoY/MoM on Section 2 (see
// attachProductChange() in server.js) — it's a cheap scalar per line item,
// not the expensive part of the original full query (that was
// refunds/shippingAddress/tags, still excluded here), so this shouldn't
// meaningfully change the latency this lighter query was built to fix.
// (Fields left out here are simply undefined on the returned node;
// aggregate() already treats refunds/shippingAddress/tags as optional via
// `|| []` / `?.`, so it runs unmodified against these lighter objects.
// unitsSold/unitsReturned/returnsTotal will come out as 0/NaN off this query
// since quantity/refunds aren't fetched — harmless, since server.js only
// reads gross_sales (store-wide and per-product) and orders off these
// periods, and overrides returns_total with the true sales_reversals figure
// for every period.)
const ORDERS_QUERY_LIGHT = `
  query OrdersForRangeLight($cursor: String, $searchQuery: String!) {
    orders(first: 100, after: $cursor, query: $searchQuery, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          totalDiscountsSet { shopMoney { amount } }
          lineItems(first: 100) {
            edges {
              node {
                title
                originalTotalSet { shopMoney { amount } }
              }
            }
          }
        }
      }
    }
  }
`;

// Same as fetchOrders, but for callers (YoY/MoM comparisons) that only need
// gross/net sales + order count out of aggregate() — see ORDERS_QUERY_LIGHT.
// -status:cancelled added 2026-08-24 — see the matching note on fetchOrders
// above; comparison periods need the same exclusion so YoY/MoM % changes
// aren't comparing a cancelled-inclusive current period against a
// cancelled-inclusive (or differently-polluted) prior period.
async function fetchOrdersLight(site, startISO, endISO) {
  const searchQuery = `created_at:>=${startISO} created_at:<${endISO} -status:cancelled`;
  const orders = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await graphql(site, ORDERS_QUERY_LIGHT, { cursor, searchQuery });
    const { edges, pageInfo } = data.orders;
    for (const edge of edges) orders.push(edge.node);
    hasNextPage = pageInfo.hasNextPage;
    cursor = pageInfo.endCursor;
  }

  return orders;
}

// Shopify's own "Sales reversals" figure (ShopifyQL), used as the
// authoritative Returns number instead of the Orders-API approximation
// above. Confirmed 2026-08-24 (Tomer: "you should pull the number from
// Shopify Sales reversals number") that the Orders-API approach — refunds
// attached to orders CREATED in the window — undercounts real returns by
// ~69% for a normal period, because Shopify attributes a sales reversal by
// the REFUND date, not the order's creation date. This queries that same
// figure Shopify itself reports.
//
// Requires the read_reports access scope AND Shopify's Level 2 protected
// customer data approval on the app (shopifyqlQuery touches customer/order
// data) — see README.md for the one-time setup Tomer needs to do in the
// Shopify Partner/Dev Dashboard before this will work. Until that's done,
// this will throw an ACCESS_DENIED-style GraphQL error.
async function fetchSalesReversals(site, startISO, endISOExclusive) {
  // ShopifyQL's UNTIL is inclusive of the given day (confirmed empirically);
  // this file's start/end convention is end-EXCLUSIVE (matches the
  // created_at:< filters above), so step back one day to convert.
  const untilDate = new Date(endISOExclusive + 'T00:00:00Z');
  untilDate.setUTCDate(untilDate.getUTCDate() - 1);
  const untilISO = untilDate.toISOString().slice(0, 10);

  const shopifyqlQueryString = `FROM sales SHOW sales_reversals SINCE ${startISO} UNTIL ${untilISO}`;
  const gqlQuery = `
    query SalesReversals($q: String!) {
      shopifyqlQuery(query: $q) {
        parseErrors
        tableData {
          columns { name }
          rows
        }
      }
    }
  `;

  const data = await graphql(site, gqlQuery, { q: shopifyqlQueryString });
  const result = data.shopifyqlQuery;
  if (result.parseErrors && result.parseErrors.length) {
    throw new Error(
      `ShopifyQL parse error for "${site}" (query: ${shopifyqlQueryString}): ${result.parseErrors.join('; ')}`
    );
  }
  const rows = result.tableData.rows;
  if (!rows || !rows.length) return 0;
  // BUG FIXED 2026-08-24: `rows` is an array of ROW OBJECTS keyed by column
  // name (e.g. { "sales_reversals": "-23994.49" }), NOT an array of arrays —
  // confirmed against a live shopifyqlQuery call. The original `rows[0][0]`
  // silently read `undefined` off that object (array-index 0 on a plain
  // object), so Number(undefined) produced NaN, which JSON.stringify turns
  // into `null` on the wire — that's what showed up as returns_total/
  // net_sales/average_order_value all coming back null in production, with
  // no thrown error (since NaN propagates through arithmetic instead of
  // throwing). Reading via Object.values() rather than the literal column
  // name keeps this working even if Shopify ever aliases the column.
  // Shopify returns the value as a negative number (it reduces sales); this
  // file's convention is a positive "returns" figure that gets SUBTRACTED,
  // so flip the sign here rather than at every call site.
  const rawValue = Object.values(rows[0])[0];
  return Math.abs(Number(rawValue));
}

// Shopify's own Cost of Goods Sold figure (ShopifyQL), pulled the same way
// as fetchSalesReversals above. Added 2026-08-24 per Tomer's request ("the
// COGS number isn't correct, you should pull it from Shopify as well") — the
// dashboard's COGS tile previously came only from the P&L Google Sheet
// (a manually maintained figure), with no live-sync path at all. That was
// documented as something this backend "genuinely can't" supply, which was
// true for the plain Orders API (it doesn't expose per-item cost) but not
// for ShopifyQL's dedicated `cost_of_goods_sold` metric under `FROM sales`.
// Confirmed live via a test query
// (`FROM sales SHOW gross_sales, cost_of_goods_sold, gross_profit`) that
// this field exists and returns real data for this shop — it relies on each
// product variant's "cost per item" being set in Shopify; a variant with no
// cost set contributes $0 here, same limitation Shopify's own reports have.
async function fetchCostOfGoodsSold(site, startISO, endISOExclusive) {
  // Same UNTIL-is-inclusive conversion as fetchSalesReversals above.
  const untilDate = new Date(endISOExclusive + 'T00:00:00Z');
  untilDate.setUTCDate(untilDate.getUTCDate() - 1);
  const untilISO = untilDate.toISOString().slice(0, 10);

  const shopifyqlQueryString = `FROM sales SHOW cost_of_goods_sold SINCE ${startISO} UNTIL ${untilISO}`;
  const gqlQuery = `
    query CostOfGoodsSold($q: String!) {
      shopifyqlQuery(query: $q) {
        parseErrors
        tableData {
          columns { name }
          rows
        }
      }
    }
  `;

  const data = await graphql(site, gqlQuery, { q: shopifyqlQueryString });
  const result = data.shopifyqlQuery;
  if (result.parseErrors && result.parseErrors.length) {
    throw new Error(
      `ShopifyQL parse error for "${site}" (query: ${shopifyqlQueryString}): ${result.parseErrors.join('; ')}`
    );
  }
  const rows = result.tableData.rows;
  if (!rows || !rows.length) return 0;
  // Same row-shape as fetchSalesReversals — an array of ROW OBJECTS keyed by
  // column name, not an array of arrays. Read via Object.values(), not
  // rows[0][0] (see the BUG FOUND & FIXED note on fetchSalesReversals above
  // — this is the exact mistake that caused a real production bug there).
  // Unlike sales_reversals, Shopify returns this as a plain positive cost
  // figure — no sign flip needed.
  const rawValue = Object.values(rows[0])[0];
  return Math.abs(Number(rawValue));
}

// Per-product Returns breakdown (Section 3 "Top Return Products" on the
// dashboard), live via ShopifyQL — added 2026-08-24 after Tomer reported
// ND.EU's Top 15 Return Products section "doesn't show at all." That section
// previously had NO live-sync path whatsoever for any site — only ND.COM
// carried a one-time, manually-pulled year-to-date snapshot baked into the
// dashboard's embedded data, so every other site (and any future month)
// always showed a "you need to upload/re-authorize" placeholder no matter
// what was clicked.
//
// This deliberately does NOT reuse aggregate()'s existing per-order refund
// data (order.refunds[].refundLineItems), even though that data is already
// fetched by ORDERS_QUERY and already carries a lineItem.title — that
// approach attributes a refund by the CREATION date of the original order,
// the same approximation that was already found (2026-08-24, see
// fetchSalesReversals above) to undercount Shopify's own reported returns by
// ~69%, because Shopify attributes a sales reversal by the REFUND date
// instead. Using the Orders-API approximation here would make Section 3's
// per-product $ values inconsistent with the accurate store-wide Returns
// figure already shown in Section 1. Instead this calls the same accurate
// `sales_reversals` ShopifyQL metric, grouped by product — the same
// technique used for ND.COM's original snapshot, just made callable live for
// any site and date range.
//
// Ranks by the SELECTED period only (not year-to-date like the ND.COM
// snapshot) — reused as-is 2026-08-25 for a second, wider-range call to
// support Section 3's "Return Ratio (YTD)" column, see server.js.
async function fetchTopReturnsByProduct(site, startISO, endISOExclusive, limit = 15) {
  // Same UNTIL-is-inclusive conversion as fetchSalesReversals/fetchCostOfGoodsSold above.
  const untilDate = new Date(endISOExclusive + 'T00:00:00Z');
  untilDate.setUTCDate(untilDate.getUTCDate() - 1);
  const untilISO = untilDate.toISOString().slice(0, 10);

  const shopifyqlQueryString = `FROM sales SHOW gross_sales, sales_reversals GROUP BY product_title ORDER BY sales_reversals ASC SINCE ${startISO} UNTIL ${untilISO} LIMIT ${limit}`;
  const gqlQuery = `
    query TopReturnsByProduct($q: String!) {
      shopifyqlQuery(query: $q) {
        parseErrors
        tableData {
          columns { name }
          rows
        }
      }
    }
  `;

  const data = await graphql(site, gqlQuery, { q: shopifyqlQueryString });
  const result = data.shopifyqlQuery;
  if (result.parseErrors && result.parseErrors.length) {
    throw new Error(
      `ShopifyQL parse error for "${site}" (query: ${shopifyqlQueryString}): ${result.parseErrors.join('; ')}`
    );
  }

  // Same row-shape caveat as fetchSalesReversals/fetchCostOfGoodsSold: rows
  // come back as an array of ROW OBJECTS, not an array of arrays — but with
  // 3 columns here (product_title, gross_sales, sales_reversals) instead of
  // 1, read each row via the `columns` list rather than a hardcoded key name
  // (Object.values() ordering isn't a documented guarantee for a 3-column
  // row the way it's fine for the single-column queries above).
  const colNames = (result.tableData.columns || []).map((c) => c.name);
  const rows = result.tableData.rows || [];
  return rows
    .map((row) => {
      const values = Array.isArray(row) ? row : colNames.map((name) => row[name]);
      const obj = {};
      colNames.forEach((name, i) => { obj[name] = values[i]; });
      return obj;
    })
    .filter((r) => r.product_title)
    .map((r) => ({
      title: r.product_title,
      gross_sales: Number(r.gross_sales) || 0,
      return_value: Math.abs(Number(r.sales_reversals) || 0),
    }));
}

// Per-country breakdown (Section 5 "Sales by Country" on the dashboard), live
// via ShopifyQL — added 2026-08-24 after Tomer reported that on ND.EU this
// section "show[s] the country by name and not by country code, also shows
// all the other data isn't showing like Return Rate, YOY, MOM."
//
// Root cause: the live-sync path's by_country previously came from
// aggregate() in src/aggregate.js, which groups raw Orders-API results by
// `order.shippingAddress?.countryCode` — a raw 2-letter ISO code (e.g. "GB"),
// with no net_sales/orders-derived AOV, no returns figure, and obviously no
// comparison-period YoY/MoM (aggregate() never sees a comparison period).
// ND.COM's embedded snapshot never had this problem because it was built by
// hand from a ShopifyQL `GROUP BY billing_country` pull, which returns full
// country display names ("United States", not "US") and can include
// sales_reversals in the same query for a real per-country return rate. This
// function makes that same technique callable live for any site/date range,
// exactly the same pattern as fetchTopReturnsByProduct above.
async function fetchCountryBreakdown(site, startISO, endISOExclusive, limit = 100) {
  // Same UNTIL-is-inclusive conversion as the other shopifyqlQuery helpers above.
  const untilDate = new Date(endISOExclusive + 'T00:00:00Z');
  untilDate.setUTCDate(untilDate.getUTCDate() - 1);
  const untilISO = untilDate.toISOString().slice(0, 10);

  const shopifyqlQueryString = `FROM sales SHOW gross_sales, net_sales, sales_reversals, orders GROUP BY billing_country ORDER BY gross_sales DESC SINCE ${startISO} UNTIL ${untilISO} LIMIT ${limit}`;
  const gqlQuery = `
    query CountryBreakdown($q: String!) {
      shopifyqlQuery(query: $q) {
        parseErrors
        tableData {
          columns { name }
          rows
        }
      }
    }
  `;

  const data = await graphql(site, gqlQuery, { q: shopifyqlQueryString });
  const result = data.shopifyqlQuery;
  if (result.parseErrors && result.parseErrors.length) {
    throw new Error(
      `ShopifyQL parse error for "${site}" (query: ${shopifyqlQueryString}): ${result.parseErrors.join('; ')}`
    );
  }

  // Same row-shape caveat as the other multi-column shopifyqlQuery helpers
  // above: rows come back as an array of ROW OBJECTS, read via the `columns`
  // list rather than a hardcoded key/positional assumption.
  const colNames = (result.tableData.columns || []).map((c) => c.name);
  const rows = result.tableData.rows || [];
  return rows
    .map((row) => {
      const values = Array.isArray(row) ? row : colNames.map((name) => row[name]);
      const obj = {};
      colNames.forEach((name, i) => { obj[name] = values[i]; });
      return obj;
    })
    .filter((r) => r.billing_country)
    .map((r) => ({
      country: r.billing_country,
      gross_sales: Number(r.gross_sales) || 0,
      net_sales: Number(r.net_sales) || 0,
      orders: Number(r.orders) || 0,
      return_value: Math.abs(Number(r.sales_reversals) || 0),
    }));
}

module.exports = {
  getSiteConfig,
  getAuthorizeUrl,
  exchangeCodeForToken,
  graphql,
  fetchOrders,
  fetchOrdersLight,
  fetchSalesReversals,
  fetchCostOfGoodsSold,
  fetchTopReturnsByProduct,
  fetchCountryBreakdown,
  API_VERSION,
  SCOPES,
};
