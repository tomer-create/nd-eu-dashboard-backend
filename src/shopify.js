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
async function fetchOrders(site, startISO, endISO) {
  const searchQuery = `created_at:>=${startISO} created_at:<${endISO}`;
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
// aggregate() in src/aggregate.js only reads gross_sales/orders (via
// lineItems + totalDiscountsSet) off the comparison periods' orders —
// top_products/by_country/discounts/units/returns are computed but discarded
// by buildDataResponse() for yoy/mom (returns now come from
// fetchSalesReversals below, for all 3 periods, not from this query), so
// there's no reason to pay for refunds/refundLineItems/shippingAddress/tags
// on those two fetches. Each of those adds real GraphQL query cost per
// order, and doing all 3 periods (current + yoy + mom) concurrently means
// they compete for the same per-shop rate-limit budget — the lighter this
// query, the less that concurrency causes THROTTLED retries. (Fields left
// out here are simply undefined on the returned node; aggregate() already
// treats refunds/shippingAddress/tags as optional via `|| []` / `?.`, so it
// runs unmodified against these lighter objects. unitsReturned/returnsTotal
// will come out as 0 off this query since there's no refunds block at all —
// harmless, since server.js overrides both with the true sales_reversals
// figure for every period.)
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
async function fetchOrdersLight(site, startISO, endISO) {
  const searchQuery = `created_at:>=${startISO} created_at:<${endISO}`;
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
  // Single column (sales_reversals), single row (no GROUP BY/TIMESERIES) —
  // Shopify returns it as a negative number (it reduces sales); this file's
  // convention is a positive "returns" figure that gets SUBTRACTED, so flip
  // the sign here rather than at every call site.
  return Math.abs(Number(rows[0][0]));
}

module.exports = {
  getSiteConfig,
  getAuthorizeUrl,
  exchangeCodeForToken,
  graphql,
  fetchOrders,
  fetchOrdersLight,
  fetchSalesReversals,
  API_VERSION,
  SCOPES,
};
