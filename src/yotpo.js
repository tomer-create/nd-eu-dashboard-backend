// src/yotpo.js
//
// Section 8 (Yotpo Loyalty) — added 2026-09-06 per Tomer: "add Yotpo Loyalty
// MCP connection to show the redeem and use of points by tier + new users
// and movement between the Tiers."
//
// ============================================================================
// READ THIS BEFORE TOUCHING ANYTHING IN THIS FILE
// ============================================================================
//
// There is NO Yotpo Loyalty MCP connector — checked the connector registry,
// nothing installed, nothing available to add. And unlike Shopify/Triple
// Whale/the P&L Google Sheet (every other data source on this dashboard),
// Yotpo's own Loyalty REST API (loyaltyapi.yotpo.com) has no bulk,
// date-ranged endpoint at all — it's customer-lookup-oriented (fetch ONE
// customer's own balance/history, or fetch the tier definitions), not a
// reporting API. There is no "give me every redemption across all
// customers this month" call to make.
//
// The only way to get real, cross-customer, date-ranged numbers is to
// receive Yotpo's own webhook events as they happen and accumulate them
// ourselves in a database — which is what this file does. Tomer confirmed
// this approach on 2026-09-06 (via AskUserQuestion) over the alternative
// (a manual periodic CSV export from Yotpo's own admin Reports page,
// closer to how the P&L sheet works today).
//
// CONSEQUENCE — Section 8 has NO historical backfill. It only knows about
// events from the moment the webhook registration (see
// scripts/register-yotpo-webhooks.js) actually goes live and Yotpo starts
// delivering. A month before that date shows "no data", not zero — the
// frontend must not silently render zeroes for a period we simply weren't
// listening yet.
//
// TOPIC STRINGS — VERIFY AGAINST REALITY. The event topic strings below
// (see the classifyTopic() patterns) are the best match found in Yotpo's
// own documentation (loyaltyapi.yotpo.com + core-api.yotpo.com's topics
// list) as of this writing — but Yotpo's docs are spread across several
// subdomains inconsistently, and none of this was verified against a real
// delivered webhook (no test account was available while building this).
// Parsing is deliberately DEFENSIVE — pattern-matched on topic substrings
// ('tier', 'redemption'/'coupon', 'account' + 'created') rather than exact
// string equality — and the full raw payload is ALWAYS stored in
// `raw_payload` regardless of whether the field-level parsing below
// recognizes it. So if Yotpo's real topic strings or payload shapes differ
// even slightly, nothing is silently dropped — check Render's logs for the
// first few real webhook deliveries after go-live, and re-parse
// `raw_payload` retroactively if any field mapping needs correcting.
//
// WHY A LOOKUP TABLE FOR "tier_from": Yotpo's tier-change webhook payload
// (confirmed from docs) carries the customer's CURRENT/new tier
// (`customer.vip_tier_name`) but no "previous tier" field at all. The only
// way to know what tier a customer is moving FROM is to remember what tier
// we last saw for them — that's what the yotpo_customers table is for.
// The very first tier event ever seen for a customer has no prior record,
// so tier_from is null for it — that's an initial classification, not a
// movement, and the aggregation query below excludes null-tier_from rows
// from the "movement between tiers" breakdown accordingly.

const { Pool } = require('pg');

let pool = null;
function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Render's managed Postgres requires SSL for external/internal
      // connections alike on most plans; rejectUnauthorized: false because
      // Render's own certs aren't in Node's default trust store the way a
      // public CA's would be — same pattern every Render Postgres quOKstart
      // example uses.
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
}

let schemaReady = null;
// Idempotent — safe to call on every server startup. Returns a promise so
// callers can await it once; subsequent calls reuse the same promise rather
// than re-running the DDL.
function ensureYotpoSchema() {
  const p = getPool();
  if (!p) return Promise.resolve(false);
  if (!schemaReady) {
    schemaReady = p
      .query(`
        CREATE TABLE IF NOT EXISTS yotpo_customers (
          site TEXT NOT NULL,
          email TEXT NOT NULL,
          current_tier TEXT,
          first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (site, email)
        );
        CREATE TABLE IF NOT EXISTS yotpo_events (
          id BIGSERIAL PRIMARY KEY,
          site TEXT NOT NULL,
          topic TEXT NOT NULL,
          event_type TEXT NOT NULL,
          email TEXT,
          tier_from TEXT,
          tier_to TEXT,
          tier_at_event TEXT,
          points NUMERIC,
          reward_name TEXT,
          received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          raw_payload JSONB NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_yotpo_events_lookup
          ON yotpo_events (site, event_type, received_at);
      `)
      .then(() => true)
      .catch((err) => {
        console.error('yotpo: schema migration failed:', err.message);
        schemaReady = null; // allow a retry on the next call rather than wedging forever
        return false;
      });
  }
  return schemaReady;
}

const VALID_SITES = ['com', 'eu', 'il'];

// Points-to-currency conversion — added 2026-09-06 per Tomer's redemption
// tiers: US $15/$20/$25/$30 = 150/200/250/300 pts; EU same point costs for
// €15/€20/€25/€30; IL ₪25/₪30/₪40/₪45/₪50 = 250/300/400/450/500 pts. Every
// one of those reduces to the exact same ratio — 10 points = 1 unit of the
// site's own local currency — so this single constant covers all 3
// sites/currencies; no per-site conversion table is needed. getYotpoSummary
// returns this value in whatever currency the site itself uses (USD for
// com, EUR for eu, ILS for il) — the frontend already knows each site's
// currency (DATA.sites[site].meta.currency) and converts to USD itself for
// the combined "All Sites (USD)" tab, the same way it does for every other
// monetary figure (see FX_TO_USD in dashboard_v2.html). If Yotpo ever adds
// a reward tier that breaks this 10:1 ratio, this is the one place to fix.
const POINTS_PER_CURRENCY_UNIT = 10;

// Classifies a webhook's topic string into one of our 4 buckets. Substring
// matching, not exact equality — see the file header for why.
function classifyTopic(topic) {
  const t = (topic || '').toLowerCase();
  if (t.includes('tier')) return 'tier_change';
  if (t.includes('redemption') || t.includes('coupon') || t.includes('reward')) return 'redemption';
  if (t.includes('account') && t.includes('creat')) return 'new_member';
  return 'other';
}

// Best-effort extraction — Yotpo's payload nests customer fields
// differently across event types (sometimes top-level `email`, sometimes
// under a `customer` object). Try both rather than assuming one shape.
function extractEmail(payload) {
  return (
    payload.email ||
    (payload.customer && payload.customer.email) ||
    null
  );
}
function extractTierName(payload) {
  return (
    (payload.customer && payload.customer.vip_tier_name) ||
    payload.vip_tier_name ||
    payload.tier_name ||
    null
  );
}
function extractPoints(payload) {
  // Redemption events: the redemption_option's point cost ("amount") is
  // what was actually spent this transaction — prefer that over
  // points_balance (a running total, not a delta) or points_earned (a
  // lifetime figure, also not this transaction's delta).
  const opt = payload.redemption_option || {};
  const amount = opt.amount !== undefined ? opt.amount : payload.amount;
  return amount !== undefined && amount !== null ? Number(amount) : null;
}
function extractRewardName(payload) {
  const opt = payload.redemption_option || {};
  return opt.name || payload.reward_text || payload.name || null;
}

// Records one incoming webhook delivery. Never throws for a
// recognition/parsing miss — the raw payload is always saved, so a shape
// we don't fully understand yet still leaves a durable trail to fix later
// rather than silently vanishing.
async function recordYotpoEvent(site, topic, payload) {
  const p = getPool();
  if (!p) throw new Error('DATABASE_URL not configured — cannot record Yotpo event');
  await ensureYotpoSchema();

  const eventType = classifyTopic(topic);
  const email = extractEmail(payload || {});
  let tierFrom = null;
  let tierTo = null;
  let tierAtEvent = null;
  let points = null;
  let rewardName = null;

  // Look up (and, for tier events, update) this customer's last-known tier
  // — this is the whole reason yotpo_customers exists (see file header).
  let priorTier = null;
  if (email) {
    const { rows } = await p.query(
      'SELECT current_tier FROM yotpo_customers WHERE site = $1 AND email = $2',
      [site, email]
    );
    priorTier = rows.length ? rows[0].current_tier : null;
  }

  if (eventType === 'tier_change') {
    tierTo = extractTierName(payload || {});
    tierFrom = priorTier; // null on this customer's very first tier event — an initial classification, not a movement
    tierAtEvent = tierTo;
    if (email && tierTo) {
      await p.query(
        `INSERT INTO yotpo_customers (site, email, current_tier, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (site, email) DO UPDATE SET current_tier = $3, updated_at = now()`,
        [site, email, tierTo]
      );
    }
  } else if (eventType === 'redemption') {
    points = extractPoints(payload || {});
    rewardName = extractRewardName(payload || {});
    tierAtEvent = priorTier; // whatever tier they were standing at when they redeemed
  } else if (eventType === 'new_member') {
    tierAtEvent = extractTierName(payload || {}); // some programs assign a starting tier on enrollment
    if (email) {
      await p.query(
        `INSERT INTO yotpo_customers (site, email, current_tier, first_seen_at, updated_at)
         VALUES ($1, $2, $3, now(), now())
         ON CONFLICT (site, email) DO NOTHING`,
        [site, email, tierAtEvent]
      );
    }
  }

  await p.query(
    `INSERT INTO yotpo_events (site, topic, event_type, email, tier_from, tier_to, tier_at_event, points, reward_name, raw_payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [site, topic || 'unknown', eventType, email, tierFrom, tierTo, tierAtEvent, points, rewardName, JSON.stringify(payload || {})]
  );
}

// Returns Section 8's summary for one site over [start, end) (ISO date
// strings, end-exclusive — same convention as every other date-ranged call
// in this backend). `earliest_event_at` tells the frontend whether this
// range is even covered by webhook collection yet — see the "no
// backfill" note in the file header; the frontend must show "no data
// collected yet" rather than a misleading all-zero summary for a period
// before go-live.
async function getYotpoSummary(site, start, end) {
  const p = getPool();
  if (!p) return null;
  await ensureYotpoSchema();

  const earliestRes = await p.query('SELECT MIN(received_at) AS earliest FROM yotpo_events WHERE site = $1', [site]);
  const earliestEventAt = earliestRes.rows[0].earliest;
  if (!earliestEventAt) {
    return { site, start, end, collecting_since: null, new_members: 0, redemptions_by_tier: [], tier_movement: [], no_data: true };
  }

  const newMembersRes = await p.query(
    `SELECT COUNT(*) AS n FROM yotpo_events
     WHERE site = $1 AND event_type = 'new_member' AND received_at >= $2 AND received_at < $3`,
    [site, start, end]
  );

  // Per Tomer's request (2026-09-06): any redemption whose tier couldn't be
  // resolved (no match in the imported Customers CSV, or a live event for a
  // customer we've never recorded a tier for — see COALESCE below) is folded
  // into BRONZE rather than shown as its own "Unknown" bucket. This is a
  // GROUP BY on the CASE expression itself, so a redemption that already had
  // a real BRONZE tier and one that fell back from "Unknown" land in the
  // exact same summed row, not two rows that happen to share a label.
  const redemptionsRes = await p.query(
    `SELECT
       CASE WHEN COALESCE(tier_at_event, 'Unknown') = 'Unknown' THEN 'BRONZE' ELSE tier_at_event END AS tier,
       COUNT(*) AS redemptions,
       COALESCE(SUM(points), 0) AS points_used
     FROM yotpo_events
     WHERE site = $1 AND event_type = 'redemption' AND received_at >= $2 AND received_at < $3
     GROUP BY tier
     ORDER BY points_used DESC`,
    [site, start, end]
  );

  const movementRes = await p.query(
    `SELECT tier_from, tier_to, COUNT(*) AS n
     FROM yotpo_events
     WHERE site = $1 AND event_type = 'tier_change' AND tier_from IS NOT NULL AND tier_from <> tier_to
       AND received_at >= $2 AND received_at < $3
     GROUP BY tier_from, tier_to
     ORDER BY n DESC`,
    [site, start, end]
  );

  return {
    site,
    start,
    end,
    collecting_since: earliestEventAt,
    no_data: false,
    new_members: Number(newMembersRes.rows[0].n),
    redemptions_by_tier: redemptionsRes.rows.map((r) => ({
      tier: r.tier,
      redemptions: Number(r.redemptions),
      points_used: Number(r.points_used),
      points_value: Number(r.points_used) / POINTS_PER_CURRENCY_UNIT,
    })),
    tier_movement: movementRes.rows.map((r) => ({
      from: r.tier_from,
      to: r.tier_to,
      count: Number(r.n),
    })),
  };
}

module.exports = {
  VALID_SITES,
  getPool,
  ensureYotpoSchema,
  recordYotpoEvent,
  getYotpoSummary,
  classifyTopic, // exported for the test harness
};
