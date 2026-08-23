// Shopify Admin API access: client-credentials token management + a small
// GraphQL request helper with basic throttle-retry handling.
//
// Each store (com / eu / il) is configured entirely through environment
// variables — see .env.example / README.md for the exact names.

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';

// In-memory token cache, keyed by site. Fine for a single-instance Render
// free/starter service; tokens are re-fetched automatically 5 minutes
// before they expire.
const tokenCache = new Map();

function getSiteConfig(site) {
  const key = site.toUpperCase();
  const domain = process.env[`SHOPIFY_${key}_DOMAIN`];
  const clientId = process.env[`SHOPIFY_${key}_CLIENT_ID`];
  const clientSecret = process.env[`SHOPIFY_${key}_CLIENT_SECRET`];
  if (!domain || !clientId || !clientSecret) {
    throw new Error(
      `Missing Shopify config for site "${site}". Expected env vars ` +
        `SHOPIFY_${key}_DOMAIN, SHOPIFY_${key}_CLIENT_ID, SHOPIFY_${key}_CLIENT_SECRET.`
    );
  }
  return { site, domain, clientId, clientSecret };
}

async function getAccessToken(site) {
  const cached = tokenCache.get(site);
  if (cached && cached.expiresAt > Date.now() + 5 * 60 * 1000) {
    return cached.token;
  }

  const { domain, clientId, clientSecret } = getSiteConfig(site);
  const res = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Shopify token request failed for "${site}" (${res.status}): ${text}`);
  }

  const data = await res.json();
  // Client-credentials tokens for custom apps are valid ~24h.
  const expiresInSec = data.expires_in || 24 * 60 * 60;
  const token = data.access_token;
  tokenCache.set(site, { token, expiresAt: Date.now() + expiresInSec * 1000 });
  return token;
}

async function graphql(site, query, variables = {}, attempt = 0) {
  const { domain } = getSiteConfig(site);
  const token = await getAccessToken(site);

  const res = await fetch(`https://${domain}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
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

module.exports = { getSiteConfig, getAccessToken, graphql, fetchOrders, API_VERSION };
