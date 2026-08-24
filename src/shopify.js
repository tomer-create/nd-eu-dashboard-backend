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
const SCOPES = 'read_orders,read_products,read_inventory';

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
// aggregate() in src/aggregate.js only reads gross_sales/net_sales/orders
// off the comparison periods' orders — top_products/by_country/discounts
// are computed but discarded by buildDataResponse() for yoy/mom, so there's
// no reason to pay for lineItem titles/shippingAddress/tags on those two
// fetches. Each of those adds real GraphQL query cost per order, and doing
// all 3 periods (current + yoy + mom) concurrently means they compete for
// the same per-shop rate-limit budget — the lighter this query, the less
// that concurrency causes THROTTLED retries.
// Includes just enough of the refunds shape (subtotalSet only, no
// quantity/lineItem title) for aggregate()'s returnsTotal to come out
// correct — Net Sales = Gross − Discounts − Returns needs this on every
// period, not just the current one, or a YoY/MoM % change would compare
// today's real (returns-subtracted) Net Sales against a comparison period's
// inflated (returns-omitted) one. unitsReturned will end up NaN off this
// query since quantity is missing, but that field isn't read from the
// comparison periods' aggregate() output, so it's harmless.
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
          refunds {
            refundLineItems(first: 100) {
              edges {
                node {
                  subtotalSet { shopMoney { amount } }
                }
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

module.exports = {
  getSiteConfig,
  getAuthorizeUrl,
  exchangeCodeForToken,
  graphql,
  fetchOrders,
  fetchOrdersLight,
  API_VERSION,
  SCOPES,
};
