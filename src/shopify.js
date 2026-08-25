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
// -status:cancelled (added 2026-08-24, NARROWED to -financial_status:voided
// on 2026-08-25 — read this note before touching this filter again):
//
// The original bug (Tomer: ND.EU's Gross Sales tile reading higher than
// Shopify's own Analytics home figure for the same range — dashboard sync:
// 633 orders / higher gross sales; Shopify's "Gross sales" panel for Aug
// 1-24, 2026: 623 orders / 71,583.46 EUR) was real: a handful of orders each
// period are Shopify order "swaps" created by a returns/exchange app (order
// notes carry `_swap-request-token`/`_swap-checkout-token`) that get
// immediately Voided (no payment ever captured) with a €0.00 net total.
// aggregate() (src/aggregate.js) sums each line item's `originalTotalSet` —
// the PRE-cancellation value — with no check on the order's status at all,
// so it kept counting these voided placeholder orders' full original value
// even though no sale ever actually happened.
//
// The FIRST fix (`-status:cancelled`) over-corrected: `status:cancelled` on
// Shopify also matches orders that were legitimately sold (payment
// captured, financial_status `refunded`/`partially_refunded`) and then
// cancelled — those orders' ORIGINAL sale amount is still counted in
// Shopify's own Gross Sales (the refund shows up separately, in "Sales
// reversals" — see fetchSalesReversals below, which server.js already uses
// as the authoritative Returns figure). Excluding ALL `status:cancelled`
// orders wholesale therefore threw away real, already-completed sales, not
// just the never-paid swap placeholders — confirmed 2026-08-25 when Tomer
// reported ND.COM's live Gross Sales reading LOWER than Shopify's own figure
// by $18,622.41 on a $489,596.45 base (Aug 1-25, 2026), the opposite
// direction from the original EU bug and a much bigger gap than a handful of
// swap orders could explain on COM's order volume — a sign real sales were
// being dropped, not just void placeholders.
//
// The fix: exclude by `financial_status:voided` instead of `status:
// cancelled`. A voided order never had a payment captured — it never became
// a completed sale, matching exactly what Shopify's own Gross Sales figure
// excludes. A cancelled-but-refunded order keeps its original gross value
// here (correct), with the refund still captured via fetchSalesReversals's
// separate sales_reversals pull — no double counting, since
// applySalesReversals() in server.js overrides aggregate()'s own
// refund-derived returns_total with that authoritative figure regardless of
// which orders this function returns. This applies to both the current
// period and the YoY/MoM comparison periods (see fetchOrdersLight below)
// since both use the same aggregate() gross_sales calculation.
async function fetchOrders(site, startISO, endISO) {
  const searchQuery = `created_at:>=${startISO} created_at:<${endISO} -financial_status:voided`;
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
// unitsReturned/returnsTotal still come out as 0 off this query since refunds
// aren't fetched — harmless, since server.js overrides returns_total with the
// true sales_reversals figure for every period and never reads a store-wide
// unitsReturned off a comparison period. unitsSold/per-product units_sold
// USED TO be 0/NaN here too before the `quantity` field below was added —
// see that note for why a comparison period's per-product unit counts are
// now needed.)
// `quantity` added 2026-08-25 alongside the ND.IL retail-price COGS feature
// (see fetchProductRetailPrices/RETAIL_COGS_SITES in server.js) — computing a
// period's implied retail value (units sold x current catalog price, per
// product) needs per-product UNIT COUNTS for the YoY/MoM comparison periods
// too, not just the current period (which already had quantity via the full
// ORDERS_QUERY). Same cheap-scalar reasoning as when `title` was added here
// on 2026-08-24: this is a plain per-line-item integer, not one of the
// expensive fields (refunds/shippingAddress/tags) that were stripped out to
// fix the original sync-timeout bug, so it shouldn't reintroduce that risk.
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
                quantity
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
// -financial_status:voided (narrowed from -status:cancelled 2026-08-25) —
// see the full note on fetchOrders above; comparison periods need the same
// exclusion so YoY/MoM % changes aren't comparing a voided-inclusive current
// period against a voided-inclusive (or differently-polluted) prior period.
async function fetchOrdersLight(site, startISO, endISO) {
  const searchQuery = `created_at:>=${startISO} created_at:<${endISO} -financial_status:voided`;
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

// Shopify's own authoritative "Gross sales / Discounts / Orders" totals
// (ShopifyQL), pulled the same way as fetchSalesReversals/fetchCostOfGoodsSold
// above. Added 2026-08-25 after TWO earlier same-day fixes
// (`-status:cancelled`, then narrowed to `-financial_status:voided` on
// fetchOrders/fetchOrdersLight's search query) tried to reconstruct which
// orders Shopify's own Gross Sales/Net Sales/Discounts tiles count by
// including/excluding orders order-by-order — and got it wrong in two
// different directions (ND.EU overcounted, then ND.COM undercounted), with a
// ~$10.6K gap still remaining even after the narrower fix, alongside a
// Shopify Help Center finding ("Pending, canceled, and unpaid orders are
// included" in Gross sales — only deleted/test orders are excluded from
// Sales reports at all) that directly contradicted the voided-order-exclusion
// premise the two prior fixes were built on.
//
// Tomer's own instruction after seeing that back-and-forth: stop trying to
// reconstruct these figures from individual orders — just pull the same
// number Shopify itself shows for each one. `shopifyqlQuery`'s `FROM sales`
// source IS what Shopify's own Analytics/Reports panels are computed from
// (same mechanism already used for fetchSalesReversals/fetchCostOfGoodsSold
// above), so a direct SHOW pull can't drift from what Tomer sees in Shopify,
// no matter what inclusion/exclusion rule Shopify applies internally for
// cancelled/voided/test/whatever-else orders — this makes the entire class
// of "which orders count" bug structurally impossible instead of chasing it
// order-status by order-status a third time.
//
// Deliberately narrow in scope: only gross_sales/discounts/orders (the 3
// figures Tomer reported as mismatched) come from here. Net Sales is still
// derived as gross_sales - discounts - sales_reversals in server.js's
// applySalesReversals() (unchanged) — using this function's authoritative
// gross_sales/discounts as the inputs instead of aggregate()'s order-derived
// ones — rather than also pulling Shopify's own `net_sales` column
// separately, so there's exactly one source of truth per figure and the
// on-page arithmetic (Gross Sales - Discounts - Returns = Net Sales) can't
// ever silently disagree with itself from two independently-rounded pulls.
// top_products/units_sold/units_returned/by_country still come from the
// Orders API via aggregate() (by_country is itself further overridden by
// fetchCountryBreakdown below) — `FROM sales` has no per-order dimension to
// replace those with.
async function fetchSalesSummary(site, startISO, endISOExclusive) {
  // Same UNTIL-is-inclusive conversion as the other shopifyqlQuery helpers above.
  const untilDate = new Date(endISOExclusive + 'T00:00:00Z');
  untilDate.setUTCDate(untilDate.getUTCDate() - 1);
  const untilISO = untilDate.toISOString().slice(0, 10);

  const shopifyqlQueryString = `FROM sales SHOW gross_sales, discounts, orders SINCE ${startISO} UNTIL ${untilISO}`;
  const gqlQuery = `
    query SalesSummary($q: String!) {
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
  // above (fetchTopReturnsByProduct/fetchCountryBreakdown): rows come back as
  // an array of ROW OBJECTS, read via the `columns` list rather than a
  // hardcoded key/positional assumption.
  const colNames = (result.tableData.columns || []).map((c) => c.name);
  const rows = result.tableData.rows || [];
  if (!rows.length) return { gross_sales: 0, discounts_total: 0, orders: 0 };
  const row = rows[0];
  const values = Array.isArray(row) ? row : colNames.map((name) => row[name]);
  const obj = {};
  colNames.forEach((name, i) => { obj[name] = values[i]; });
  return {
    gross_sales: Number(obj.gross_sales) || 0,
    // Shopify returns this as a negative "reduces sales" number, same sign
    // convention as sales_reversals (see fetchSalesReversals above) — flip to
    // a positive dollar figure, this file's convention throughout.
    discounts_total: Math.abs(Number(obj.discounts) || 0),
    orders: Number(obj.orders) || 0,
  };
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
//
// UPDATED 2026-08-25 — Tomer asked for this section to reflect the SHIP-TO
// address instead of the bill-to address (they can differ: gift orders,
// corporate billing addresses, etc. — shipping is what actually determines
// where the order was fulfilled). This is a switch away from the
// `billing_country` grouping above, which was itself only ever chosen because
// it's what the embedded ND.COM snapshot happened to be built from, not
// because Tomer asked for billing specifically.
//
// `shipping_country` is not confirmed against a live query in this round —
// the analytics tool used to build the original ND.COM snapshot (a different,
// higher-level tool than the raw shopifyqlQuery field this function calls)
// didn't expose a shipping-country grouping option as of 2026-08-24 (see the
// note baked into that snapshot's `by_country_note`), so it's possible this
// exact field name doesn't exist on the `sales` dataset either. Rather than
// ship an untested field name that could hard-break Section 5 entirely if
// it's wrong, this tries `shipping_country` first and — if ShopifyQL rejects
// it for ANY reason — falls back to the previously-working `billing_country`
// grouping. `groupedBy` on the return value tells the caller which one
// actually worked, so the frontend can show Tomer an honest label instead of
// silently mislabeling billing-address data as shipping-address data.
async function fetchCountryBreakdown(site, startISO, endISOExclusive, limit = 100) {
  // Same UNTIL-is-inclusive conversion as the other shopifyqlQuery helpers above.
  const untilDate = new Date(endISOExclusive + 'T00:00:00Z');
  untilDate.setUTCDate(untilDate.getUTCDate() - 1);
  const untilISO = untilDate.toISOString().slice(0, 10);

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

  async function runGroupedBy(dimension) {
    const shopifyqlQueryString = `FROM sales SHOW gross_sales, net_sales, sales_reversals, orders GROUP BY ${dimension} ORDER BY gross_sales DESC SINCE ${startISO} UNTIL ${untilISO} LIMIT ${limit}`;
    const data = await graphql(site, gqlQuery, { q: shopifyqlQueryString });
    const result = data.shopifyqlQuery;
    if (result.parseErrors && result.parseErrors.length) {
      throw new Error(
        `ShopifyQL parse error for "${site}" (query: ${shopifyqlQueryString}): ${result.parseErrors.join('; ')}`
      );
    }

    // Same row-shape caveat as the other multi-column shopifyqlQuery helpers
    // above: rows come back as an array of ROW OBJECTS, read via the
    // `columns` list rather than a hardcoded key/positional assumption.
    const colNames = (result.tableData.columns || []).map((c) => c.name);
    const rows = result.tableData.rows || [];
    return rows
      .map((row) => {
        const values = Array.isArray(row) ? row : colNames.map((name) => row[name]);
        const obj = {};
        colNames.forEach((name, i) => { obj[name] = values[i]; });
        return obj;
      })
      .filter((r) => r[dimension])
      .map((r) => ({
        country: r[dimension],
        gross_sales: Number(r.gross_sales) || 0,
        net_sales: Number(r.net_sales) || 0,
        orders: Number(r.orders) || 0,
        return_value: Math.abs(Number(r.sales_reversals) || 0),
      }));
  }

  try {
    const rows = await runGroupedBy('shipping_country');
    return { rows, groupedBy: 'shipping_country' };
  } catch (shippingErr) {
    const rows = await runGroupedBy('billing_country');
    return {
      rows,
      groupedBy: 'billing_country',
      fallbackReason: String((shippingErr && shippingErr.message) || shippingErr),
    };
  }
}

// Product catalog query for fetchProductRetailPrices below — plain Admin API
// (not shopifyqlQuery), since Shopify's catalog/pricing data isn't part of
// the `sales` ShopifyQL dataset used everywhere else in this file. Only
// needs `read_products`, already in SCOPES — no re-authorization required for
// this feature, unlike the shopifyqlQuery-based helpers above.
const PRODUCTS_QUERY = `
  query ProductsForRetailPrice($cursor: String) {
    products(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          title
          priceRangeV2 { minVariantPrice { amount } }
        }
      }
    }
  }
`;

// Pulls the CURRENT Shopify catalog price for every product, keyed by
// product title — added 2026-08-25 for the ND.IL COGS feature ("on ND.IL
// COGS should be calculated as 30% out of the gross sales" → clarified to
// "a different retail/list price" → "take the product price from Shopify
// directly", not a manually-supplied price list). Used by
// computeCogsFromRetailPrices() in server.js to estimate a period's implied
// retail value as (units sold x this catalog price), per product, then take
// a fixed % of that as COGS.
//
// Keyed by TITLE, matching the same title-only granularity aggregate() and
// attachChangeByKey() already use throughout this codebase for per-product
// data — there's no stable product ID carried through the orders pipeline to
// match on instead (see the attachChangeByKey comment in server.js). For a
// product with multiple variants (e.g. different shades) sharing one title,
// this uses `priceRangeV2.minVariantPrice` — the lowest-priced variant — as a
// single representative price rather than fetching every variant's own sales
// split (aggregate() doesn't track sales by variant, only by title, so a
// true weighted-average price isn't available without a bigger rework). This
// slightly UNDERSTATES retail value (and therefore COGS) for a multi-priced
// product versus its true sales mix — acceptable for a percentage-based
// estimate, but worth knowing if ND.IL's catalog has meaningfully
// wide-ranging variant prices under one title.
//
// This is a CURRENT snapshot of catalog prices, not a historical price
// at-time-of-sale — a product whose price changed mid-period (or since) will
// have its ENTIRE period's units valued at today's price. Tomer asked
// explicitly to pull "the product price from Shopify directly" rather than
// maintain a separate price list, so this trade-off is the direct
// consequence of that choice; flag it if ND.IL runs frequent price changes
// and the resulting COGS estimate looks unstable month to month.
//
// Fetches the full catalog once per Sync (paginated, 250 products/page) —
// this is independent of date range, so it's called once and reused for the
// current/YoY/MoM periods in the same request rather than 3 times.
async function fetchProductRetailPrices(site) {
  const prices = new Map();
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await graphql(site, PRODUCTS_QUERY, { cursor });
    const { edges, pageInfo } = data.products;
    for (const edge of edges) {
      const { title, priceRangeV2 } = edge.node;
      const price = Number(priceRangeV2?.minVariantPrice?.amount || 0);
      prices.set(title, price);
    }
    hasNextPage = pageInfo.hasNextPage;
    cursor = pageInfo.endCursor;
  }

  return prices;
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
  fetchSalesSummary,
  fetchProductRetailPrices,
  API_VERSION,
  SCOPES,
};
